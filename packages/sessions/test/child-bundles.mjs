import assert from "node:assert/strict"
import { appendFile, cp, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SessionCatalog } from "../dist/catalog.js"
import { ChildSidecars, lastWords, toolIdsOf, withChildReferences } from "../dist/child-sidecars.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { DevinCliProvider } from "../dist/providers/devin-cli.js"
import { DevinLocalProvider } from "../dist/providers/devin-local.js"
import { GrokProvider } from "../dist/providers/grok.js"
import { OpenCodeProvider } from "../dist/providers/opencode.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { renderTranscriptBundle } from "../dist/transcript.js"

/**
 * A transcript bundle carrying a session's child agents, for every harness's
 * child fixture: each child rendered into a folder of its own by the same
 * renderer from its harness's reader, indexed with how much of it is here
 * and what it reported, linked from the call that started it and the events
 * that reported on it; rendered once and reused while its record is
 * unchanged, and read only when a bundle carries it.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "child-transcripts")
const root = await mkdtemp(join(tmpdir(), "mako-child-bundles-"))
await cp(fixtures, root, { recursive: true })
const home = (harness) => join(root, harness, "home")
const stores = new NativeStores(false)
const devinCli = new DevinCliProvider(stores, home("devin"))
const providers = [
  new ClaudeProvider(home("claude")),
  new CodexProvider(stores, home("codex")),
  new GrokProvider(home("grok")),
  new OpenCodeProvider(stores, home("opencode")),
  devinCli,
  new DevinLocalProvider(stores, join(home("devin"), "Library", "Application Support", "Devin", "User")),
  new CursorProvider(stores, home("cursor"), {}),
]
const catalog = new SessionCatalog(providers)

/** The catalog as a bundle reads it, counting each transcript it opens. */
const opened = []
const source = {
  children: (path) => catalog.children(path),
  open: (path) => {
    opened.push(path)
    return catalog.open(path, false)
  },
}

async function parentAt(match) {
  const ref = (await catalog.scan()).find((candidate) => match(candidate.path))
  assert.ok(ref, "the fixture's parent is listed")
  return ref.path
}

const sessions = {
  claude: (path) => path.endsWith("b225fcff-5836-4c8a-b1ac-9429eb0c8ac8.jsonl"),
  codex: (path) => path.includes("01a10e20-ea2e-75a1-9728-1d897d685d09"),
  grok: (path) => path.includes("01a126f0-248c-74a3-8c22-38664b0f71f6") && !path.includes("subagents"),
  opencode: (path) => path.endsWith("ses_fdc264d6fffeaYK66JeOGZmfKC"),
  devin: (path) => path.endsWith("#proximal-pine-headed"),
  "devin-app": (path) => path.endsWith("5b1f6f2e-0000-4000-8000-00000000d001.db"),
  "cursor-acp": (path) => path.includes("acp-sessions"),
  "cursor-sdk": (path) => path.includes("cursor-sdk"),
}

try {
  const sidecarRoot = join(root, "bundles", "children")
  const bundles = new Map()
  for (const [name, match] of Object.entries(sessions)) {
    const path = await parentAt(match)
    const thread = await catalog.open(path, false)
    const listed = await catalog.children(path)
    assert.ok(listed?.children.length, `${name}: the parent lists children`)
    const carried = await new ChildSidecars(sidecarRoot).bundle(source, [{ path, toolIds: toolIdsOf(thread.entries), whole: true }])
    assert.equal(carried.children.length, listed.children.length, `${name}: a whole session carries every child it started`)
    for (const child of carried.children) {
      if (child.state.kind === "missing") {
        assert.equal(child.transcript, undefined, `${name}: a missing child links no transcript`)
        continue
      }
      assert.ok(child.transcript, `${name}: ${child.nativeId} is rendered beside the bundle`)
      assert.ok(child.transcript.entries > 0)
      const markdown = await readFile(join(dirname(sidecarRoot), "bundle", child.transcript.link), "utf8")
      assert.match(markdown, /^# /m, `${name}: ${child.nativeId}'s transcript is a bundle of its own`)
    }
    const bundle = renderTranscriptBundle(thread, { mainBudget: Infinity, totalBudget: Infinity, children: carried.children })
    assert.match(bundle.markdown, /^## Child agents$/m)
    const counts = bundle.metadata.children
    assert.equal(counts.indexed, listed.children.length)
    const started = carried.children.filter((child) => child.toolId && toolIdsOf(thread.entries).has(child.toolId))
    assert.equal(counts.linked, started.length, `${name}: every child whose call the parent carries is linked from it`)
    assert.equal(bundle.markdown.match(/^Starts child agent /gm)?.length ?? 0, started.length)
    if (counts.partial + counts.missing > 0)
      assert.ok(bundle.metadata.losses.some((loss) => loss.kind === "children-incomplete"), `${name}: incomplete children are a declared loss`)
    bundles.set(name, { path, thread, carried, bundle })
  }

  // Claude Code: the background agent's report reaches the bundle as the event's body, labelled as its report.
  const claude = bundles.get("claude")
  const reported = claude.bundle.markdown.split("\n### ").find((section) => section.includes('Agent "Run sleep 301 and report" finished'))
  assert.ok(reported, "the notification is an event")
  assert.match(reported, /^Reports on child agent \d+ — Run sleep 301 and report \(complete\): \[its transcript\]\(\.\.\/children\//m)
  assert.match(reported, /Body:\n`{3,}text\nThe `sleep 301` is now running in the background/, "its <result> is the body")
  assert.match(claude.bundle.markdown, /harness-internal|source harness told its own model/, "the launch call's output is marked as the harness's own")
  const nested = claude.carried.children.find((child) => child.spawnedBy)
  assert.ok(nested, "a nested child comes with the child that started it")
  assert.match(claude.bundle.markdown, new RegExp(`- Started by: child agent \\d+ — Run sleep 301 and report`))

  // Reused: a second bundle reads no child transcript while no record changed.
  opened.length = 0
  const again = await new ChildSidecars(sidecarRoot).bundle(source, [{ path: claude.path, toolIds: toolIdsOf(claude.thread.entries), whole: true }])
  assert.deepEqual(opened, [], "an unchanged child is not read again")
  assert.equal(again.stats.rendered, 0)
  assert.equal(again.stats.reused, claude.carried.children.filter((child) => child.transcript).length)
  assert.deepEqual(again.children.map((child) => child.transcript?.link), claude.carried.children.map((child) => child.transcript?.link))

  // A child that grew is rendered again, with the child that started it, whose transcript links its folder; no other is read.
  const listedClaude = await catalog.children(claude.path)
  const grown = listedClaude.children.find((child) => child.nativeId === "a0000000000000002")
  const last = JSON.parse((await readFile(grown.path, "utf8")).trim().split("\n").at(-1))
  await appendFile(grown.path, `${JSON.stringify({ ...last, type: "assistant", uuid: "fixture-bundle-1", message: { role: "assistant", content: [{ type: "text", text: "Still going" }] }, timestamp: "2026-09-27T05:00:01.000Z" })}\n`)
  opened.length = 0
  const regrown = await new ChildSidecars(sidecarRoot).bundle(source, [{ path: claude.path, toolIds: toolIdsOf(claude.thread.entries), whole: true }])
  const starter = listedClaude.children.find((child) => child.nativeId === grown.spawnedBy)
  assert.deepEqual(opened, [grown.path, starter.path], "the grown child is read, then the one that links it")
  assert.equal(regrown.stats.rendered, 2)
  assert.equal(regrown.children.find((child) => child.nativeId === grown.nativeId).last?.text, "Still going", "an unfinished child's last activity is what it last did")

  // A bundle from part of a session carries only the children its calls started, and theirs.
  const none = await new ChildSidecars(sidecarRoot).bundle(source, [{ path: claude.path, toolIds: new Set(), whole: false }])
  assert.deepEqual(none.children, [])
  const one = await new ChildSidecars(sidecarRoot).bundle(source, [{ path: claude.path, toolIds: new Set(["toolu_01SJNsU4DAPq889b4D5SHP19"]), whole: false }])
  assert.deepEqual(one.children.map((child) => child.nativeId).sort(), ["a0000000000000002", "a5c530d641cdf5d79"])

  // Written into another harness's store: each launch call says where its child's transcript is.
  const sidecars = new ChildSidecars(sidecarRoot)
  const referenced = withChildReferences(claude.thread, claude.carried.children, (link) => sidecars.file(link))
  const outputs = referenced.entries.flatMap((entry) => (entry.kind === "assistant" ? entry.blocks.filter((block) => block.type === "tool" && block.name === "Agent") : []))
  const located = outputs.find((block) => block.id === "toolu_01SJNsU4DAPq889b4D5SHP19")
  const file = located.output.match(/at (\/\S+transcript\.md)\./)?.[1]
  assert.ok(file && (await stat(file)).isFile(), "the reference names a transcript that exists")
  assert.match(located.output, /It can't be reached from this session\.\]$/)
  assert.match(outputs.find((block) => block.id === "toolu_01MissingChildFixture000").output, /left no transcript on this Mac/)
  assert.equal(referenced.entries.length, claude.thread.entries.length, "references add no entries")

  // Every harness has children rendered through its own reader.
  const harnessesRendered = new Set([...bundles.values()].flatMap(({ carried }) => carried.children.filter((child) => child.transcript).map((child) => child.harness)))
  assert.deepEqual([...harnessesRendered].sort(), ["claude", "codex", "cursor", "devin", "grok", "opencode"])

  // A child resumed and finishing again: each of its reports is numbered, the index carries every one, and its last words aren't repeated.
  const longReport = "Final words. ".repeat(400)
  const twice = {
    ref: { harness: "claude", nativeId: "parent", path: "/fixture/parent.jsonl" },
    entries: [
      { kind: "user", text: "Start the helper" },
      { kind: "assistant", blocks: [{ type: "tool", id: "call-1", name: "Agent", input: "{}", output: "agentId: helper (use SendMessage to continue)" }] },
      { kind: "event", at: "2026-10-13T01:00:00.000Z", label: 'Agent "Helper" finished', cause: { kind: "agent", name: "Helper", outcome: "finished" }, body: "First report, the one with the findings" },
      { kind: "user", text: "Ask the helper again" },
      { kind: "assistant", blocks: [{ type: "tool", id: "call-2", name: "SendMessage", input: '{"to":"a-helper-0001"}', output: "sent" }] },
      { kind: "event", at: "2026-10-13T02:00:00.000Z", label: 'Agent "Helper" finished', cause: { kind: "agent", name: "Helper", outcome: "finished" }, body: longReport },
    ],
  }
  const helper = { nativeId: "a-helper-0001", harness: "claude", title: "Helper", toolId: "call-1", state: { kind: "complete" }, last: { at: "2026-10-13T01:59:59.000Z", text: longReport } }
  const resumed = renderTranscriptBundle(twice, { mainBudget: Infinity, totalBudget: Infinity, children: [helper] })
  assert.match(resumed.markdown, /Report 1 of 2 on this agent/)
  assert.match(resumed.markdown, /Report 2 of 2 on this agent/)
  assert.match(resumed.markdown, /^- Reports: 2, in Turn 1, Turn 2; one each time a run of it ended/m)
  assert.match(resumed.markdown, /^Names child agent 1 — Helper \(complete\)\. A child agent can't be reached from this session\.$/m, "a later call naming the child says it can't be reached")
  const index = resumed.markdown.slice(resumed.markdown.indexOf("## Child agents"), resumed.markdown.indexOf("## Turn "))
  assert.match(index, /^Report 1 of 2, in Turn 1 at 2026-10-13T01:00:00\.000Z \(39 characters, complete inline\):\n`{3,}text\nFirst report, the one with the findings$/m, "an earlier report is in the index too")
  assert.match(index, /^Report 2 of 2, its final report, in Turn 2 at 2026-10-13T02:00:00\.000Z: \[transcript-assets\/child-000001-final-report\.txt\]/m)
  assert.doesNotMatch(index, /Last words/, "last words that were its last report aren't repeated")
  const reportAsset = resumed.assets.find((asset) => asset.path === "transcript-assets/child-000001-final-report.txt")
  assert.equal(reportAsset?.content, longReport, "a long final report goes whole to a sidecar")

  // A report whose tags the harness neutralized still says what the last words say.
  const neutralized = { ...twice, entries: twice.entries.map((entry, index) => (index === 5 ? { ...entry, body: "Reads `<\\task-notification>` lines." } : entry)) }
  const same = renderTranscriptBundle(neutralized, { mainBudget: Infinity, totalBudget: Infinity, children: [{ ...helper, last: { ...helper.last, text: "Reads `<task-notification>` lines." } }] })
  assert.doesNotMatch(same.markdown, /Last words/)

  // A child resumed after its last report that never reported again: that report isn't called final, and what it did after is shown.
  const ranOn = renderTranscriptBundle(twice, { mainBudget: Infinity, totalBudget: Infinity, children: [{ ...helper, last: { at: "2026-10-13T02:30:00.000Z", text: "Halfway through the second pass." } }] })
  assert.match(ranOn.markdown, /^- Ended: not reported\. It ran again after its last report/m)
  assert.match(ranOn.markdown, /^Report 2 of 2, in Turn 2 at /m)
  assert.match(ranOn.markdown, /^Last words in its transcript, after its last report at 2026-10-13T02:30:00\.000Z \(32 characters, complete inline\):$/m)
  assert.doesNotMatch(ranOn.markdown, /final report/i)

  // A child a usage limit cut off: its last words come with what it did after them.
  const worked = [
    { kind: "user", text: "Audit it" },
    { kind: "assistant", at: "2026-10-13T06:17:29.000Z", blocks: [{ type: "text", text: "Now the audit script." }, { type: "tool", id: "t-1", name: "Write", input: '{"file_path":"audit.ts"}' }] },
    { kind: "user", text: "", toolResult: true },
    { kind: "assistant", at: "2026-10-13T07:03:30.000Z", blocks: [{ type: "tool", id: "t-2", name: "Bash", input: '{\n  "command": "npm test"\n}' }] },
  ]
  assert.deepEqual(lastWords(worked), { at: "2026-10-13T06:17:29.000Z", text: "Now the audit script.", after: { calls: 1, at: "2026-10-13T07:03:30.000Z", call: 'Bash { "command": "npm test" }' } })
  assert.deepEqual(lastWords(worked.filter((entry) => entry.kind !== "assistant" || !entry.blocks.some((block) => block.type === "text"))), { text: "", after: { calls: 1, at: "2026-10-13T07:03:30.000Z", call: 'Bash { "command": "npm test" }' } })
  const limited = {
    ...twice,
    entries: [...twice.entries.slice(0, 2), { kind: "event", label: 'Agent "Helper" failed: usage limit', cause: { kind: "agent", name: "Helper", agentId: "a-helper-0001", outcome: "failed" }, body: "usage limit" }],
  }
  const cutOff = renderTranscriptBundle(limited, { mainBudget: Infinity, totalBudget: Infinity, children: [{ ...helper, last: lastWords(worked) }] })
  assert.match(cutOff.markdown, /^Report, in Turn 1; it failed \(11 characters, complete inline\):$/m)
  assert.match(cutOff.markdown, /^Last words in its transcript before it failed at 2026-10-13T06:17:29\.000Z \(21 characters, complete inline\):$/m)
  assert.match(cutOff.markdown, /^After those words it made 1 call; the last at 2026-10-13T07:03:30\.000Z:\n`{3,}text\nBash \{ "command": "npm test" \}$/m)
  const silent = renderTranscriptBundle(limited, { mainBudget: Infinity, totalBudget: Infinity, children: [{ ...helper, last: { text: "", after: { calls: 4, call: "Read" } } }] })
  assert.match(silent.markdown, /^It wrote no text before it failed\.\n\nIt made 4 calls; the last:/m)
  assert.doesNotMatch(silent.markdown, /Final report/)

  console.log(`child bundles: ${bundles.size} parents across six harnesses carry their children; a report is its event's body; a reused bundle reads no child; a grown child is read with only the child that links it`)
} finally {
  await catalog.stop()
  devinCli.close()
  await rm(root, { recursive: true, force: true })
}
