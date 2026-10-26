import assert from "node:assert/strict"
import { appendFile, chmod, cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SessionCatalog } from "../dist/catalog.js"
import { childCompleteness } from "../dist/child-completeness.js"
import { parseDaemonRequest, parseDaemonResponse } from "../dist/daemon-wire.js"
import { RecordStore } from "../dist/record-store.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { DevinCliProvider } from "../dist/providers/devin-cli.js"
import { DevinLocalProvider } from "../dist/providers/devin-local.js"
import { GrokProvider } from "../dist/providers/grok.js"
import { OpenCodeProvider } from "../dist/providers/opencode.js"
import { keepCopies } from "./fixtures/archive-copies.mjs"
import { NativeStores } from "../dist/read-only-sqlite.js"

/**
 * Each harness's child agents, from stores trimmed out of real sessions
 * (Mako's session flows on Claude Code 2.1.283, Codex 0.159.3, Grok 1.0.46,
 * OpenCode 2, Devin CLI 3000.10 and Cursor's CLI and SDK 1.0.31), with the
 * cases a store holds that those sessions didn't — a nested child, a child
 * its harness no longer keeps, an exact Devin head, a Devin.app journal —
 * derived from them: listed with the call that started each and how much of
 * it is here, read through the same reader as any session, kept by Mako's
 * archive under its parent, followed while it grows, and listed without
 * reading a single child's transcript.
 */

const stores = new NativeStores(false)
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "child-transcripts")
const root = await mkdtemp(join(tmpdir(), "mako-child-transcripts-"))
await cp(fixtures, root, { recursive: true })
const home = (harness) => join(root, harness, "home")
const ids = (children) => children.map((child) => [child.nativeId, child.state.kind, child.toolId ?? null, child.spawnedBy ?? null])

async function only(reader, match) {
  const file = (await reader.discover()).find((candidate) => match(candidate.path))
  assert.ok(file, "the fixture's session is discovered")
  return file.path
}

/** A child read through its harness's reader, with its link to the parent. */
async function readsWithLink(reader, child, parentId) {
  const thread = await reader.read(child.path)
  assert.ok(thread, `${child.nativeId} reads`)
  assert.ok(thread.entries.length > 0, `${child.nativeId} reads with entries`)
  assert.equal(thread.ref.nativeId, child.nativeId)
  assert.equal(thread.ref.path, child.path)
  assert.equal(thread.ref.childOf?.nativeId, parentId, `${child.nativeId} names its parent`)
  return thread
}

try {
  // Claude Code: subagents/ beside the session; meta names the call, the result or a notification the end.
  const claude = new ClaudeProvider(home("claude"))
  const foreground = await only(claude, (path) => path.endsWith("c308232d-05bb-469c-a2c2-6d75b0c707d9.jsonl"))
  const [subagent] = await claude.children(foreground)
  assert.deepEqual(ids([subagent]), [["ae36e705387a97d23", "complete", "toolu_01TtNf3UyBxSUaBimPQhWxFd", null]])
  assert.equal(subagent.title, "Reply with a fixed word")
  assert.equal(subagent.role, "general-purpose")
  const read = await readsWithLink(claude, subagent, "c308232d-05bb-469c-a2c2-6d75b0c707d9")
  assert.equal(read.ref.childOf.toolId, "toolu_01TtNf3UyBxSUaBimPQhWxFd")
  assert.equal(read.entries[0].type, "user", "a subagent's transcript opens with the task it was given")
  assert.match(read.entries[0].text, /Reply with exactly the word agent-a574c987/)
  assert.ok(read.entries.some((entry) => entry.type === "text" && entry.text === "agent-a574c987"))
  const background = await only(claude, (path) => path.endsWith("b225fcff-5836-4c8a-b1ac-9429eb0c8ac8.jsonl"))
  const children = await claude.children(background)
  assert.deepEqual(ids(children).sort(), [
    ["a0000000000000001", "missing", "toolu_01MissingChildFixture000", null],
    ["a0000000000000002", "partial", "toolu_01NestedChildFixture0000", "a5c530d641cdf5d79"],
    ["a5c530d641cdf5d79", "complete", "toolu_01SJNsU4DAPq889b4D5SHP19", null],
  ], "a background child ends with its notification; a nested one hangs under the child that started it; a result with no transcript is missing")
  for (const child of children.filter((entry) => entry.path)) await readsWithLink(claude, child, "b225fcff-5836-4c8a-b1ac-9429eb0c8ac8")
  // The subagent's transcript begins with the request records Claude Code 2.1.310 writes there (their shape, its
  // values reduced): they name the parent's sessionId and no isSidechain, and once made a write to the file list it
  // as the parent, in the parent's row.
  assert.equal(await claude.peek({ path: subagent.path, bytes: (await stat(subagent.path)).size, mtimeMs: 0 }), null, "a child is never a row")
  assert.deepEqual((await new SessionCatalog([new ClaudeProvider(home("claude"))]).scan()).map((ref) => ref.nativeId).sort(), ["b225fcff-5836-4c8a-b1ac-9429eb0c8ac8", "c308232d-05bb-469c-a2c2-6d75b0c707d9"])

  // Codex: spawn edges in the state database, the rollout each child keeps, SubAgentActivity naming the call.
  const codex = new CodexProvider(stores, home("codex"))
  const thread = await only(codex, (path) => path.includes("01a10e20-ea2e-75a1-9728-1d897d685d09"))
  const spawned = await codex.children(thread)
  assert.deepEqual(ids(spawned).sort(), [
    ["01a10e20-fecd-7ca1-985c-fa7759e10935", "complete", "call_6cd310ec845c4b90b4021b27da5680ed", null],
    ["01a10e21-0000-7000-8000-000000000f01", "missing", null, null],
    ["01a10e21-0000-7000-8000-00000000f102", "complete", null, "01a10e20-fecd-7ca1-985c-fa7759e10935"],
  ])
  const gone = spawned.find((child) => child.state.kind === "missing")
  assert.match(gone.state.reason, /no longer keeps this thread's rollout/)
  assert.equal(gone.title, "Gone fixture agent")
  await readsWithLink(codex, spawned.find((child) => child.nativeId.endsWith("e10935")), "01a10e20-ea2e-75a1-9728-1d897d685d09")
  await readsWithLink(codex, spawned.find((child) => child.spawnedBy), "01a10e20-fecd-7ca1-985c-fa7759e10935")
  const codexRecords = await codex.records(thread)
  assert.ok(codexRecords.files.some((file) => file.includes("01a10e20-fecd-7ca1-985c-fa7759e10935")), "the parent's records carry its spawned agents' rollouts")
  assert.ok(codexRecords.files.some((file) => file.includes("00000000f102")), "and theirs")
  const recordFolder = await mkdtemp(join(tmpdir(), "mako-child-records-"))
  const store = new RecordStore(recordFolder, stores)
  try {
    const captured = await store.capture({ harness: "codex", nativeId: "parent", home: home("codex"), records: codexRecords })
    const edges = captured.versions.filter((version) => version.unit.split("\t")[2] === "thread_spawn_edges")
    assert.equal(edges.length, 3, "every spawn edge under the thread is captured with it")
  } finally {
    await store.close()
    await rm(recordFolder, { recursive: true, force: true })
  }

  // Grok: subagents/<id>/meta.json beside the session, the child a session of its own elsewhere in the tree.
  const grok = new GrokProvider(home("grok"))
  const grokParent = await only(grok, (path) => path.includes("01a126f0-248c-74a3-8c22-38664b0f71f6"))
  const [grokChild] = await grok.children(grokParent)
  assert.deepEqual(ids([grokChild]), [["01a126f0-32d6-78d1-beb0-a935c2054941", "complete", "call-b6583b68-f660-4a70-ab52-b7b51eb7f22f-0", null]])
  assert.equal(grokChild.model, "grok-4.7")
  await readsWithLink(grok, grokChild, "01a126f0-248c-74a3-8c22-38664b0f71f6")
  assert.ok((await grok.records(grokParent)).files.some((file) => file.startsWith(dirname(grokChild.path))), "the parent's records carry its subagent's session")

  // OpenCode: sessions under it by parent_id, the subagent call naming the child's session.
  const opencode = new OpenCodeProvider(stores, home("opencode"))
  const openParent = await only(opencode, (path) => path.endsWith("ses_fdc264d6fffeaYK66JeOGZmfKC"))
  const [openChild] = await opencode.children(openParent)
  assert.deepEqual(ids([openChild]), [["ses_fdc26429cffes4AcERzOslYhbr", "complete", "call_29U95JJIyT0KMPh6rzRYl8Iz", null]])
  const openRead = await readsWithLink(opencode, openChild, "ses_fdc264d6fffeaYK66JeOGZmfKC")
  assert.equal(openRead.ref.childOf.path, openParent)

  // Devin CLI: a chain in the session's own forest, exact by subagent_heads, else matched by its task.
  const devin = new DevinCliProvider(stores, home("devin"))
  const matched = await only(devin, (path) => path.endsWith("#proximal-pine"))
  const [byTask] = await devin.children(matched)
  assert.deepEqual(ids([byTask]), [["b5178c1c", "partial", "run_subagent:0#907ff1659ce84bda87e215928310cd85", null]])
  assert.match(byTask.state.reason, /matched by its task/)
  const taskRead = await readsWithLink(devin, byTask, "proximal-pine")
  assert.match(taskRead.entries[0].text, /^Your only job is to reply with exactly the word/)
  const headed = await only(devin, (path) => path.endsWith("#proximal-pine-headed"))
  const [byHead] = await devin.children(headed)
  assert.deepEqual(ids([byHead]), [["b5178c1c", "complete", "run_subagent:0#907ff1659ce84bda87e215928310cd85", null]], "a recorded head is exact, and the session reported its end")
  assert.deepEqual((await readsWithLink(devin, byHead, "proximal-pine-headed")).entries.map((entry) => entry.type), taskRead.entries.map((entry) => entry.type))
  devin.close()

  // Devin.app: the journal keeps a subagent's messages inside its `subagent` message, or nothing of it.
  const devinApp = new DevinLocalProvider(stores, join(home("devin"), "Library", "Application Support", "Devin", "User"))
  const journal = await only(devinApp, (path) => path.endsWith(".db"))
  const journaled = await devinApp.children(journal)
  assert.deepEqual(ids(journaled).sort(), [
    ["call_fixtureBackground0001", "missing", "call_fixtureBackground0001", null],
    ["call_fixtureForeground0002", "complete", "call_fixtureForeground0002", null],
  ])
  const journalRead = await readsWithLink(devinApp, journaled.find((child) => child.path), "5b1f6f2e-0000-4000-8000-00000000d001")
  assert.ok(journalRead.entries.some((entry) => entry.type === "text" && entry.text.includes("freezes on Friday")))

  // Cursor: a cursor-agent child kept as its own store; an SDK child kept only as a plain transcript.
  const cursor = new CursorProvider(stores, home("cursor"))
  const acp = await only(cursor, (path) => path.includes("acp-sessions"))
  const [storeChild] = await cursor.children(acp)
  assert.deepEqual(ids([storeChild]), [["22222222-2222-4222-8222-2222222222b2", "complete", "toolu_01FixtureTaskCall0000001", null]])
  assert.equal(storeChild.title, "Read the release notes")
  await readsWithLink(cursor, storeChild, "11111111-1111-4111-8111-1111111111a1")
  const sdk = await only(cursor, (path) => path.includes("cursor-sdk"))
  const [plain] = await cursor.children(sdk)
  assert.deepEqual(ids([plain]), [["81eac7ea-6928-4f3f-88d6-a59889954ccd", "partial", "tool_e9621c37-7854-4b25-a3f7-75109fc0ad4", null]], "the SDK's run events name the call")
  assert.match(plain.state.reason, /plain transcript/)
  const plainRead = await readsWithLink(cursor, plain, "f482147a-289b-45b6-bc78-9df55a4cd5f1")
  assert.ok(plainRead.entries.some((entry) => entry.type === "tool" && entry.name === "Shell"), "its calls read as rows without results")
  assert.ok((await cursor.records(acp)).databases.some((database) => database.path === storeChild.path), "the parent's records carry its child's store")

  // The proof every harness's report gives: every located child reads, every direct call is a row.
  const reports = await childCompleteness([claude, codex, cursor, grok, opencode, devin, devinApp])
  for (const report of reports) assert.deepEqual(report.failures, [], `${report.harness}: ${JSON.stringify(report.failures)}`)
  assert.deepEqual(Object.fromEntries(reports.map((report) => [report.harness, [report.children, report.decoded, report.missing]])), {
    claude: [4, 3, 1], codex: [4, 3, 1], cursor: [2, 2, 0], grok: [1, 1, 0], opencode: [1, 1, 0], devin: [4, 3, 1],
  })

  // The catalog lists a session's children, opens one like any session, and lists a copy an earlier build kept once its harness drops it.
  const archivePath = join(root, "archive")
  const first = new SessionCatalog([new ClaudeProvider(home("claude"))], { archivePath })
  await first.scan()
  const listed = await first.children(background)
  assert.deepEqual(listed.parent, { harness: "claude", nativeId: "b225fcff-5836-4c8a-b1ac-9429eb0c8ac8", path: background })
  assert.equal(listed.children.length, 3)
  const page = await first.page(listed.children.find((child) => child.nativeId === "a5c530d641cdf5d79").path)
  assert.ok(page.entries.length > 0 && page.ref.childOf.nativeId === "b225fcff-5836-4c8a-b1ac-9429eb0c8ac8", "a child's path pages like any session's")
  const dropped = listed.children.find((child) => child.nativeId === "a5c530d641cdf5d79")
  const copied = await first.open(dropped.path)
  await keepCopies(archivePath, [{ ...copied, ref: { ...copied.ref, childOf: { nativeId: listed.parent.nativeId, path: background, toolId: dropped.toolId, ended: true } } }])
  await first.stop()
  await rm(dropped.path)
  const after = new SessionCatalog([new ClaudeProvider(home("claude"))], { archivePath })
  await after.scan()
  const kept = (await after.children(background)).children.find((child) => child.nativeId === "a5c530d641cdf5d79")
  assert.deepEqual([kept.archived, kept.state.kind, kept.toolId], [true, "complete", "toolu_01SJNsU4DAPq889b4D5SHP19"], "a kept copy of a child its harness dropped lists under its parent, with how it ended")
  const fromArchive = await after.open(kept.path)
  assert.equal(fromArchive.ref.archived, true)
  assert.ok(fromArchive.entries.length > 0)
  assert.ok(!after.list().some((ref) => ref.path === kept.path), "an archived child is never a row")
  await after.stop()

  // The daemon and the catalog worker carry a listing whole.
  assert.deepEqual(parseDaemonRequest(JSON.stringify({ id: 7, op: "children", path: background })), { id: 7, op: "children", path: background })
  const wire = parseDaemonResponse(JSON.parse(JSON.stringify({ id: 7, ok: true, result: listed })), { kind: "children", resolve() {}, reject() {}, timer: undefined })
  assert.deepEqual(wire?.result, listed)

  // A running child is followed from where its page ended: only what it appends arrives.
  const growing = listed.children.find((child) => child.nativeId === "a0000000000000002")
  const follower = new SessionCatalog([new ClaudeProvider(home("claude"))])
  const opened = await follower.open(growing.path)
  const arrived = []
  const stop = follower.follow(growing.path, opened.checkpoint, (entries) => arrived.push(...entries))
  const last = JSON.parse((await readFile(growing.path, "utf8")).trim().split("\n").at(-1))
  await appendFile(growing.path, `${JSON.stringify({ ...last, type: "user", uuid: "fixture-follow-1", message: { role: "user", content: "One more thing" }, timestamp: "2026-09-27T05:00:00.000Z" })}\n`)
  for (let wait = 0; wait < 100 && !arrived.length; wait++) await new Promise((resolve) => setTimeout(resolve, 50))
  stop()
  await follower.stop()
  assert.deepEqual(arrived.map((entry) => [entry.type, entry.text]), [["user", "One more thing"]], "a follow delivers the appended line alone")

  // Twenty children, each a 2 MB transcript: listing reads none of them.
  const wide = join(root, "wide")
  await cp(join(home("claude"), ".claude"), join(wide, ".claude"), { recursive: true })
  const wideReader = new ClaudeProvider(wide)
  const wideParent = await only(wideReader, (path) => path.endsWith("c308232d-05bb-469c-a2c2-6d75b0c707d9.jsonl"))
  const folder = join(dirname(wideParent), "c308232d-05bb-469c-a2c2-6d75b0c707d9", "subagents")
  const template = await readFile(join(folder, "agent-ae36e705387a97d23.jsonl"), "utf8")
  const filler = `${JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "x".repeat(64 * 1024) }] } })}\n`.repeat(32)
  for (let index = 0; index < 20; index++) {
    const agent = `a${String(index).padStart(16, "0")}`
    await writeFile(join(folder, `agent-${agent}.jsonl`), template + filler)
    await writeFile(join(folder, `agent-${agent}.meta.json`), JSON.stringify({ agentType: "general-purpose", description: `Wide ${index}`, toolUseId: `toolu_wide${index}` }))
    // Unreadable: a listing that opened a transcript would fail here.
    await chmod(join(folder, `agent-${agent}.jsonl`), 0o000)
  }
  const started = performance.now()
  const wideChildren = await wideReader.children(wideParent)
  const elapsed = performance.now() - started
  assert.equal(wideChildren.length, 21, "twenty unreadable transcripts list from their links alone")
  assert.ok(elapsed < 500, `listing twenty children took ${Math.round(elapsed)} ms`)
  for (const name of await readdir(folder)) await chmod(join(folder, name), 0o644)
  console.log(`child transcripts: every harness lists, links and reads its children; a kept copy of a dropped one lists under its parent; a follow reads only the appended line; twenty 2 MB children list in ${Math.round(elapsed)} ms without a read`)
} finally {
  await rm(root, { recursive: true, force: true })
}

