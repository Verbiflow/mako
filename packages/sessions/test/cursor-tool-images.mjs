import assert from 'node:assert/strict'
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {appendPromptAttachments} from '../dist/prompt-attachments.js'
import {CursorProvider} from '../dist/providers/cursor.js'

const home = await mkdtemp(join(tmpdir(), 'mako-cursor-tool-images-'))
try {
  const dir = join(home, '.cursor', 'acp-sessions', 'image-proof')
  await mkdir(dir, {recursive: true})
  await writeFile(join(dir, 'meta.json'), JSON.stringify({cwd: home, title: 'Image proof'}))
  const path = join(dir, 'store.db')
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    const messages = [
      {role: 'user', content: [{type: 'text', text: appendPromptAttachments('<user_query>inspect screenshot</user_query>', [{name: 'data.har', mimeType: 'application/json', path: '/tmp/data.har'}])}]},
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'capture', toolName: 'screenshot', args: {}}]},
      {role: 'tool', content: [{
        type: 'tool-result', toolCallId: 'capture', result: {width: 10, height: 10},
        experimental_content: [
          {type: 'text', text: 'Captured'},
          {type: 'image', data: 'cHJvb2Y=', mimeType: 'image/png'},
        ],
      }]},
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'toolu_plan', toolName: 'CreatePlan', args: {name: 'Fix', overview: 'Fix it', plan: '# Fix\n\n1. Patch.'}}]},
    ]
    const rootFields = []
    for (const [index, message] of messages.entries()) {
      const hash = Buffer.alloc(32, index + 1)
      db.prepare('INSERT INTO blobs VALUES (?, ?)').run(hash.toString('hex'), Buffer.from(JSON.stringify(message)))
      rootFields.push(Buffer.from([10, 32]), hash)
    }
    db.prepare('INSERT INTO blobs VALUES (?, ?)').run('root', Buffer.concat(rootFields))
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('0', JSON.stringify({agentId: 'image-proof', name: 'Image proof', latestRootBlobId: 'root'}))
  } finally {
    db.close()
  }
  const thread = await new CursorProvider(home).read(path)
  const user = thread.entries.find(entry => entry.kind === 'user')
  assert.equal(user.text, 'inspect screenshot')
  assert.deepEqual(user.attachments, [{type: 'attachment', name: 'data.har', mimeType: 'application/json', source: {kind: 'file', path: '/tmp/data.har'}}])
  const tool = thread?.entries.flatMap(entry => entry.kind === 'assistant' ? entry.blocks : []).find(block => block.type === 'tool')
  assert.equal(tool?.name, 'screenshot')
  assert.deepEqual(tool?.attachments, [{
    type: 'attachment', name: 'image', mimeType: 'image/png', source: {kind: 'inline', data: 'cHJvb2Y='},
  }])
  assert.equal(tool.output, '{"width":10,"height":10}')
  console.log('PASS Cursor native experimental_content preserves image bytes and structured text output')
  const plans = thread.entries.flatMap(entry => entry.kind === 'assistant' ? entry.blocks : []).filter(block => block.type === 'proposed-plan')
  assert.deepEqual(plans, [{type: 'proposed-plan', id: 'toolu_plan', text: '# Fix\n\n1. Patch.', status: 'proposed'}])
  console.log('PASS Cursor saved CreatePlan reads as the live plan card')
} finally {
  await rm(home, {recursive: true, force: true})
}
