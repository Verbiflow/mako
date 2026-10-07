import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DevinLocalProvider } from '../dist/providers/devin-local.js'
import { SessionCatalog } from '../dist/catalog.js'
import { AcpUpdateDecoder } from '../dist/acp-decoder.js'
import { DEVIN_ACP_HOOKS } from '../dist/harnesses/devin.js'
import { reduceLiveUpdates } from '../dist/live-content.js'

const user = await mkdtemp(join(tmpdir(), 'mako-devin-ide-'))
const uuid = 'ide-journal-fixture'
const nativeId = 'shared-session'
const root = join(user, 'acp-messages')
await mkdir(root)
await mkdir(join(user, 'globalStorage'))
const state = new DatabaseSync(join(user, 'globalStorage', 'state.vscdb'))
state.exec('PRAGMA journal_mode=WAL; CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT)')
const store = new DatabaseSync(join(root, `${uuid}.db`))
store.exec('PRAGMA journal_mode=WAL; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE messages(position INTEGER PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL)')
store.prepare('INSERT INTO meta VALUES(?,?)').run('schema_version', '1')
const note = (kind, content, position) => store.prepare('INSERT INTO messages VALUES(?,?,?)').run(position, kind, JSON.stringify({kind, content}))
const chunk = (sessionUpdate, text) => ({sessionUpdate, content: {type: 'text', text}, _meta: {'cognition.ai/timestamp': '2026-10-02T00:00:00Z'}})
note('user_message', [chunk('user_message_chunk', 'Check the generated output')], 0)
note('agent_thought', [chunk('agent_thought_chunk', 'Inspecting')], 1)
note('agent_message', [chunk('agent_message_chunk', 'Here is '), chunk('agent_message_chunk', 'the result')], 2)
note('tool_call', {toolCallId: 'write-1', title: 'write_file', rawInput: {path: '/fixture/report.md'}, status: 'completed', content: [{type: 'content', content: {type:'text',text:'Saved'}}]}, 3)
state.prepare('INSERT INTO ItemTable VALUES(?,?)').run(`windsurf.acp.messageStore.session.acp/devin-cli/${nativeId}`, JSON.stringify({uuid, lastUpdated: 1_759_363_200_000}))
state.prepare('INSERT INTO ItemTable VALUES(?,?)').run(`windsurf.acp.sessioninfo.session.acp/devin-cli/${nativeId}`, JSON.stringify({providerId:'acp/devin-cli', info:{sessionId: `acp/devin-cli/${nativeId}`, title:'Generated output', cwd:'/fixture/project'}}))
try {
  const provider = new DevinLocalProvider(user)
  const [file] = await provider.discover()
  assert.ok(file)
  const thread = await provider.read(file.path) // No prior peek required.
  assert.equal(thread.ref.nativeId, nativeId)
  assert.equal(thread.ref.title, 'Generated output')
  assert.equal(thread.ref.cwd, '/fixture/project')
  assert.equal(thread.entries[0].text, 'Check the generated output')
  const blocks = thread.entries.filter(e=>e.kind==='assistant').flatMap(e=>e.blocks)
  assert.equal(blocks.find(b=>b.type==='text').text, 'Here is the result')
  const tool = blocks.find(b=>b.type==='tool')
  assert.equal(tool.id, 'write-1')
  assert.equal(tool.output, 'Saved')
  assert.equal(provider.createFollower(file.path, thread.checkpoint), null)
  assert.equal(await provider.recent(file.path, 1), null)
  const before = await provider.stat(file.path)
  note('agent_message', [chunk('agent_message_chunk', 'New snapshot output')], 4)
  const after = await provider.stat(file.path)
  assert.notEqual(before.revision, after.revision, 'WAL writes change the session revision')
  assert.equal(provider.watchTarget(`${file.path}-wal`), file.path)
  assert.equal(provider.watchTarget(`${file.path}-shm`), file.path)
  assert.ok((await provider.read(file.path)).entries.some(e=>e.kind==='assistant'&&e.blocks.some(b=>b.type==='text'&&b.text.includes('New snapshot output'))))
  // A CLI view and the IDE index identify one catalog row.
  const cli = {
    harness:'devin', displayName:'Devin', roots:()=>[],
    discover:async()=>[{path:'/fixture/cli',bytes:1,mtimeMs:1}],
    peek:async()=>({...thread.ref,path:'/fixture/cli'}),
    read:async()=>({...thread,ref:{...thread.ref,path:'/fixture/cli'}}),
  }
  const catalog = new SessionCatalog([provider,cli],{cachePath:join(user,'catalog.json')})
  await catalog.scan()
  assert.equal(catalog.list().filter(ref=>ref.nativeId===nativeId).length, 1)
  await catalog.stop()
  note('agent_message', [chunk('agent_message_chunk', 'x'.repeat(4_000_001))], 5)
  const bounded = await provider.read(file.path)
  assert.ok(bounded.entries.some(entry=>entry.kind==='event'&&entry.label==='Message unavailable'))
  assert.ok(!JSON.stringify(bounded).includes('x'.repeat(1000)), 'oversized native rows do not enter the canonical history')
  // Unknown schemas fail visibly, instead of claiming an empty conversation.
  store.prepare("UPDATE meta SET value='99' WHERE key='schema_version'").run()
  await assert.rejects(provider.read(file.path), /could not be read just now/)
  // Original append-only journals remain readable.
  await mkdir(join(user,'acp-events'))
  const legacy = join(user,'acp-events','legacy.ndjson')
  await writeFile(legacy, JSON.stringify({notification:chunk('user_message_chunk','Legacy prompt')})+'\n')
  assert.equal((await provider.read(legacy)).entries[0].text, 'Legacy prompt')

  // The journal reads through the hooks the live client runs, so it draws what the live session did.
  const at = (second) => ({'cognition.ai/timestamp': `2026-10-02T00:00:0${second}Z`})
  const said = (id, text, second) => ({sessionUpdate: 'user_message_chunk', content: {type: 'text', text}, _meta: {...at(second), 'cognition.ai/clientMessageId': id}})
  const updates = [
    said('m1', 'Run the ', 0),
    said('m1', 'tests', 0),
    {sessionUpdate: 'tool_call', toolCallId: 'exec-1', title: 'Run npm test', kind: 'execute', status: 'in_progress', rawInput: {command: 'npm test'}, content: [{type: 'content', content: {type: 'resource', resource: {uri: 'tool://preview', text: 'npm test'}}}], _meta: {...at(1), 'cognition.ai/inferenceToolName': 'exec'}},
    {sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'failed', content: [{type: 'content', content: {type: 'text', text: '1 failing'}}], _meta: at(2)},
    {sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read notes.md', kind: 'read', status: 'failed', _meta: {...at(3), 'cognition.ai/inferenceToolName': 'read', 'cognition.ai/canceled': true}},
    {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'Context compacted'}, _meta: {...at(3), 'cognition.ai/displayMessage': true}},
    {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'One test fails.'}, _meta: at(4)},
    said('m2', 'Fix it', 5),
  ]
  const journal = join(user, 'acp-events', 'locator.ndjson')
  await writeFile(journal, updates.map((notification) => JSON.stringify({notification})).join('\n') + '\n')
  const read = await provider.read(journal)
  assert.deepEqual(read.entries.map((entry) => entry.kind), ['user', 'assistant', 'user'])
  assert.equal(read.entries[0].text, 'Run the tests', 'chunks of one client message are one prompt')
  const [exec, canceled, reply] = read.entries[1].blocks
  assert.deepEqual([exec.name, JSON.parse(exec.input).command, exec.output, exec.error], ['exec', 'npm test', '1 failing', true])
  assert.equal(exec.details, undefined, "Devin's own command preview stays out")
  assert.deepEqual([canceled.name, canceled.canceled, canceled.error], ['read', true, undefined])
  assert.deepEqual(reply, {type: 'text', text: 'One test fails.'}, 'a status line Devin keeps out of its store stays out')
  const live = new AcpUpdateDecoder(DEVIN_ACP_HOOKS)
  const drawn = reduceLiveUpdates([], updates.slice(2, -1).flatMap((update) => live.update({sessionId: 'locator', update})).flatMap((item) => item.kind === 'update' ? [item.update] : []))
  assert.deepEqual(drawn.map((block) => block.type === 'tool' ? [block.name, block.status] : [block.type, block.text]), [['exec', 'failed'], ['read', 'canceled'], ['text', 'One test fails.']], 'the reader draws what the live decoder draws')
  console.log('Devin IDE SQLite: native identity, WAL snapshot updates, tool results, bounded peek, catalog deduplication, unknown schema refusal, legacy journal preservation, and live-decoder locator reading pass')
} finally {
  store.close(); state.close()
  await rm(user,{recursive:true,force:true})
}
