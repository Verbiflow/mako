import assert from "node:assert/strict"
import { appendFile, cp, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SessionCatalog } from "../dist/catalog.js"
import { ChildSidecars, lastWords, toolIdsOf } from "../dist/child-sidecars.js"
import { entriesFromMessages } from "../dist/entry-sink.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { DevinCliProvider } from "../dist/providers/devin-cli.js"
import { DevinLocalProvider } from "../dist/providers/devin-local.js"
import { GrokProvider } from "../dist/providers/grok.js"
import { OpenCodeProvider } from "../dist/providers/opencode.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { buildTranscript } from "../dist/transcript-builder.js"
import { checkTranscript } from "./transcript-checker.mjs"

/**
 * A transcript carrying a session's child agents, for every harness's child
 * fixture: each child built into a folder of its own by the same builder
 * from its harness's reader, indexed with how much of it is here and what
 * it last said, linked from the call that started it and the events that
 * reported on it; built once and reused while its record is unchanged, and
 * read only when a transcript carries it.
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
  new CursorProvider(stores, home("cursor")),
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
    const bundle = await buildTranscript({ entries: thread.entries, harness: name, children: carried.children })
    checkTranscript(thread.entries, bundle)
    assert.match(bundle.markdown, /^## Child agents$/m)
    assert.equal(bundle.markdown.match(/^### Child agent \d+/gm)?.length, listed.children.length, `${name}: every child is indexed`)
    const started = new Set(carried.children.flatMap((child) => (child.toolId && toolIdsOf(thread.entries).has(child.toolId) ? [child.toolId] : [])))
    assert.equal(bundle.markdown.match(/^Child agent: /gm)?.length ?? 0, started.size, `${name}: every child whose call the parent carries is named at it`)
    if (carried.children.some((child) => child.state.kind !== "complete"))
      assert.ok(bundle.losses.some((loss) => /child agent/.test(loss)), `${name}: incomplete children are a declared loss`)
    bundles.set(name, { path, thread, carried, bundle })
  }

  // Claude Code: the background agent's report reaches the transcript as the event's body, after the child it reports on.
  const claude = bundles.get("claude")
  const reported = claude.bundle.markdown.split("\n### ").find((section) => /^(?:Event|Harness turn)/.test(section) && section.includes('Agent "Run sleep 301 and report" finished'))
  assert.ok(reported, "the notification is an event")
  assert.match(reported, /^Reports on child agent \d+ Run sleep 301 and report \(complete, \.\.\/children\//m)
  assert.match(reported, /The `sleep 301` is now running in the background/, "its <result> is the body")
  assert.match(claude.bundle.markdown, /What its output says about reaching it works only inside the harness that ran it\./, "the launch call's output is marked as the harness's own")
  const nested = claude.carried.children.find((child) => child.spawnedBy)
  assert.ok(nested, "a nested child comes with the child that started it")
  assert.match(claude.bundle.markdown, /^claude \S+ .*· started by child agent \d+/m)

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

  // Every harness has children rendered through its own reader.
  const harnessesRendered = new Set([...bundles.values()].flatMap(({ carried }) => carried.children.filter((child) => child.transcript).map((child) => child.harness)))
  assert.deepEqual([...harnessesRendered].sort(), ["claude", "codex", "cursor", "devin", "grok", "opencode"])

  // A child resumed and finishing again: each of its reports is numbered, the index carries every one, and its last words aren't repeated.
  const longReport = "Final words. ".repeat(400)
  const twice = {
    ref: { harness: "claude", nativeId: "parent", path: "/fixture/parent.jsonl" },
    entries: entriesFromMessages([
      { kind: "user", text: "Start the helper" },
      { kind: "assistant", blocks: [{ type: "tool", id: "call-1", name: "Agent", input: "{}", output: "agentId: helper (use SendMessage to continue)" }] },
      { kind: "event", at: "2026-10-13T01:00:00.000Z", label: 'Agent "Helper" finished', cause: { kind: "agent", name: "Helper", outcome: "finished" }, body: "First report, the one with the findings" },
      { kind: "user", text: "Ask the helper again" },
      { kind: "assistant", blocks: [{ type: "tool", id: "call-2", name: "SendMessage", input: '{"to":"a-helper-0001"}', output: "sent" }] },
      { kind: "event", at: "2026-10-13T02:00:00.000Z", label: 'Agent "Helper" finished', cause: { kind: "agent", name: "Helper", outcome: "finished" }, body: longReport },
    ]),
  }
  const helper = { nativeId: "a-helper-0001", harness: "claude", title: "Helper", toolId: "call-1", state: { kind: "complete" }, last: { at: "2026-10-13T01:59:59.000Z", text: longReport } }
  const resumed = await buildTranscript({ ...twice, harness: "Claude Code", children: [helper] })
  checkTranscript(twice.entries, resumed)
  assert.equal(resumed.markdown.match(/^Reports on child agent 1 Helper \(complete\)$/gm)?.length, 2, "each report says whom it's from")
  assert.match(resumed.markdown, /^### Call 1: SendMessage\nNames: child agent 1 Helper \(complete\)$/m, "a later call naming the child says which it is")
  const index = resumed.markdown.slice(resumed.markdown.indexOf("## Child agents"), resumed.markdown.indexOf("## Turn "))
  assert.match(index, /^Last words: its last report, in turn 2\.$/m, "last words that were its last report aren't repeated")
  assert.ok(resumed.files.some((file) => file.bytes.toString("utf8") === longReport), "a long report goes whole to a file")

  // A report whose tags the harness neutralized still says what the last words say.
  const neutralized = { ...twice, entries: twice.entries.map((entry, index) => (index === 5 ? { ...entry, body: "Reads `<\\task-notification>` lines." } : entry)) }
  const same = await buildTranscript({ ...neutralized, harness: "Claude Code", children: [{ ...helper, last: { ...helper.last, text: "Reads `<task-notification>` lines." } }] })
  assert.match(same.markdown, /^Last words: its last report, in turn 2\.$/m)

  // A child resumed after its last report that never reported again: what it last said is shown.
  const ranOn = await buildTranscript({ ...twice, harness: "Claude Code", children: [{ ...helper, last: { at: "2026-10-13T02:30:00.000Z", text: "Halfway through the second pass." } }] })
  assert.match(ranOn.markdown, /^Last words at 2026-10-13T02:30:00\.000Z:\n```\nHalfway through the second pass\.\n```$/m)

  // A child a usage limit cut off: its last words come with what it did after them.
  const worked = [
    { type: "user", text: "Audit it" },
    { type: "text", at: Date.parse("2026-10-13T06:17:29.000Z"), text: "Now the audit script." },
    { type: "tool", id: "t-1", at: Date.parse("2026-10-13T06:17:29.000Z"), name: "Write", input: '{"file_path":"audit.ts"}' },
    { type: "tool", id: "t-2", at: Date.parse("2026-10-13T07:03:30.000Z"), name: "Bash", input: '{\n  "command": "npm test"\n}' },
  ]
  assert.deepEqual(lastWords(worked), { at: "2026-10-13T06:17:29.000Z", text: "Now the audit script.", after: { calls: 2, at: "2026-10-13T07:03:30.000Z", call: 'Bash { "command": "npm test" }' } },
    "every call after the words counts, the one in the same reply too")
  assert.deepEqual(lastWords(worked.filter((entry) => entry.type !== "text")), { text: "", after: { calls: 2, at: "2026-10-13T07:03:30.000Z", call: 'Bash { "command": "npm test" }' } })
  const limited = {
    ...twice,
    entries: [...twice.entries.slice(0, 2), { type: "event", label: 'Agent "Helper" failed: usage limit', cause: { kind: "agent", name: "Helper", agentId: "a-helper-0001", outcome: "failed" }, body: "usage limit" }],
  }
  const cutOff = await buildTranscript({ ...limited, harness: "Claude Code", children: [{ ...helper, last: lastWords(worked) }] })
  checkTranscript(limited.entries, cutOff)
  assert.match(cutOff.markdown, /^Last words at 2026-10-13T06:17:29\.000Z:\n```\nNow the audit script\.\n```\nAfter those words it made 2 calls; the last at 2026-10-13T07:03:30\.000Z: Bash \{ "command": "npm test" \}$/m)
  const silent = await buildTranscript({ ...limited, harness: "Claude Code", children: [{ ...helper, last: { text: "", after: { calls: 4, call: "Read" } } }] })
  assert.match(silent.markdown, /^It wrote no text\.\nAfter that it made 4 calls; the last: Read$/m)

  console.log(`child bundles: ${bundles.size} parents across six harnesses carry their children, read back whole; a report is its event's body; a reused transcript reads no child; a grown child is read with only the child that links it`)
} finally {
  await catalog.stop()
  devinCli.close()
  await rm(root, { recursive: true, force: true })
}
