import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { capturedHandoff, ContextBundles, liveEntries, prepareLiveContext } from "@mako/host/conversations/live-context"
import { translatorBuild, type ChildSource, type ChildTranscripts, type Thread } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"

/**
 * A conversation handed to another harness carries the child agents its
 * native sessions started, on the live path: the bundle indexes and links
 * them, a launch call's harness-internal output is marked, a report reaches
 * the bundle as its event's body even when the imported history was decoded
 * by code that dropped it, and a conversation written into the destination's
 * own store says where each child's transcript is. Synthetic shapes only.
 */

const root = await mkdtemp(join(tmpdir(), "mako-live-context-children-"))
const parentPath = join(root, "parent.jsonl")
const childPath = join(root, "child.jsonl")
const report = "The helper read both files and found the cause."

const launch: Entry = {
  type: "tool",
  id: "call-helper",
  name: "Agent",
  status: "completed",
  input: '{"description":"Helper"}',
  output: "agentId: a-helper-0001 (use SendMessage with to: 'a-helper-0001' to continue this agent)\noutput_file: /private/tmp/tasks/a-helper-0001.output",
}
/** As a decoder that dropped the agent's report kept it. */
const staleReport: Entry = { type: "provider-turn", id: "record-7", reason: 'Agent "Helper" finished' }
/** As this build's decoder reads the same record. */
const freshReport: Entry = { ...staleReport, cause: { kind: "agent", name: "Helper", agentId: "a-helper-0001", outcome: "finished" }, body: report }
const ref = { harness: "claude", nativeId: "parent-session", path: parentPath, cwd: root }
const baseEntries: Entry[] = [{ type: "user", id: "u-1", text: "Find the cause" }, launch, staleReport]

const child: Thread = {
  ref: { harness: "claude", nativeId: "a-helper-0001", path: childPath, cwd: root },
  entries: [
    { type: "user", id: "c-1", text: "Read both files" },
    { type: "text", id: "c-2", text: report },
  ],
}
const listing: ChildTranscripts = {
  parent: { harness: "claude", nativeId: "parent-session", path: parentPath },
  children: [{ nativeId: "a-helper-0001", toolId: "call-helper", title: "Helper", role: "general-purpose", path: childPath, state: { kind: "complete" } }],
}

const reads: string[] = []
const native: ChildSource = {
  children: async (path) => (path === parentPath ? listing : null),
  open: async (path) => {
    reads.push(path)
    if (path === parentPath) return { ref, entries: [baseEntries[0]!, launch, freshReport] }
    return path === childPath ? child : null
  },
}
const bundles = new ContextBundles(native)

function snapshot(translator: string, blocks: LiveSnapshot["blocks"] = []): LiveSnapshot {
  return {
    session: { id: "conversation", harness: "claude", cwd: root, status: "ready", connection: "disconnected", modes: [], currentMode: null, configOptions: [], nativeId: "parent-session", nativePath: parentPath },
    revision: 1,
    createdAt: 1,
    base: { ref, entries: baseEntries, start: 0, total: baseEntries.length, hasEarlier: false, translator },
    baseCoveredBlocks: 0,
    requests: [],
    permissions: [],
    blocks,
  }
}

try {
  // The records exist for their size and time; their reader is `native`.
  await writeFile(parentPath, "{}\n")
  await writeFile(childPath, "{}\n")

  // Live blocks keep an event's cause and report, as the decoder gave them.
  const live = liveEntries([
    { type: "provider-turn", reason: 'Agent "Helper" finished', cause: { kind: "agent", name: "Helper", agentId: "a-helper-0001", outcome: "finished" }, body: report, at: 1_000 },
    { type: "event", id: "e-1", label: 'Agent "Helper" finished', cause: { kind: "agent", name: "Helper", outcome: "finished" }, body: report },
  ])
  assert.deepEqual(live.map((entry) => (entry.type === "event" || entry.type === "provider-turn" ? [entry.cause?.kind, entry.body] : [])), [["agent", report], ["agent", report]])

  // A base decoded by older code: read again, the report is the event's body, linked to its child.
  const stale = snapshot("an-older-build")
  const manifest = await prepareLiveContext({ snapshot: stale, root: join(root, "context"), fromBlock: 0, includesBase: true, bundles })
  const markdown = await readFile(manifest.file, "utf8")
  assert.match(markdown, /^## Child agents$/m)
  assert.match(markdown, /^Reports on child agent 1 — Helper \(complete\): \[its transcript\]\(\.\.\/children\/[^)]+\/transcript\.md\)\.$/m)
  assert.match(markdown, /Body:\n`{3,}text\nThe helper read both files and found the cause\.\n/)
  assert.match(markdown, /^Starts child agent 1 — Helper \(complete\)[^\n]*None of it reaches the agent from this session/m)
  assert.match(markdown, /^Final report, in Turn \d+ \(\d+ characters, complete inline\):\n`{3,}text\nThe helper read both files/m)
  const childFile = manifest.resources?.find((file) => file.endsWith("transcript.md"))
  assert.ok(childFile && (await stat(childFile)).isFile(), "the child's transcript is among the bundle's resources")
  assert.match(await readFile(childFile, "utf8"), /Read both files/)
  assert.deepEqual(reads, [parentPath, childPath], "the stale base and the child are each read once")

  // A base this build decoded is not read again; a child already rendered is not either.
  reads.length = 0
  const current = await prepareLiveContext({ snapshot: snapshot(translatorBuild()), root: join(root, "context"), fromBlock: 0, includesBase: true, bundles })
  assert.deepEqual(reads, [], "nothing is read when the base is current and the child unchanged")
  assert.ok(current.resources?.includes(childFile))

  // A bundle of only the turns after the base carries no child its calls didn't start.
  const later = await prepareLiveContext({ snapshot: snapshot(translatorBuild(), [{ type: "user", text: "Thanks" }]), root: join(root, "context"), fromBlock: 0, includesBase: false, bundles })
  assert.doesNotMatch(await readFile(later.file, "utf8"), /## Child agents/)

  // Without the catalog, a bundle carries no children and still renders.
  const bare = await prepareLiveContext({ snapshot: stale, root: join(root, "context"), fromBlock: 0, includesBase: true, bundles: new ContextBundles() })
  assert.doesNotMatch(await readFile(bare.file, "utf8"), /## Child agents/)

  // Written into another harness's store: the launch call says where its child's transcript is.
  const handoff = await capturedHandoff(stale, join(root, "context"), bundles)
  assert.equal(handoff.entries.length, baseEntries.length)
  const call = handoff.entries[1]
  const output = call?.type === "tool" ? (call.output ?? "") : ""
  assert.match(output, /^agentId: a-helper-0001/, "what the source harness said stays")
  assert.match(output, /\[Mako: child agent "Helper" \(complete\) ran in a transcript of its own, at \/\S+\/transcript\.md\. It can't be reached from this session\.\]$/)
  const event = handoff.entries[2]
  assert.equal(event?.type === "provider-turn" ? event.body : undefined, report, "the handoff carries the report too")

  console.log("live context children: bundle indexes and links the child, a stale base's report is read again, a current one isn't, a native handoff names the child's transcript")
} finally {
  await rm(root, { recursive: true, force: true })
}
