import assert from "node:assert/strict"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { mock } from "node:test"
import { isDeepStrictEqual, parseArgs } from "node:util"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { createLiveEngine, type EngineLive } from "@mako/host/harnesses/live-engine"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { AcpUpdateDecoder } from "@mako/sessions/acp-decoder"
import { acpSavedNotification, SavedAcpUpdateSchema } from "../packages/sessions/src/acp-saved-turns.ts"
import { ClaudeProjection } from "@mako/sessions/claude-projection"
import { CursorSdkMessageSchema, CursorSdkProjection, cursorUnfinishedToolNote, type CursorTurnOutcome } from "@mako/sessions/cursor-sdk-content"
import { DEVIN_ACP_HOOKS, GROK_ACP_HOOKS } from "@mako/sessions/harnesses"
import { deliverLiveUpdates, reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { OpenCodeContent } from "@mako/sessions/opencode-content"
import { absolutePath, liveEffectsStatus, namedPaths, reportedEffects, savedToolEffects, scriptRuns, wholePatch } from "@mako/sessions/tool-effect-reading"
import type { ToolEffect, ToolEffects } from "@mako/sessions/tool-effects"
import { liveUpdates, PairSchema, PAIRS_FOLDER, storeReader } from "./decode-compare.ts"
import { FIXTURE_ROOT, readRecording } from "./native-decoding.ts"

/**
 * What each harness's tool calls report doing (`@mako/sessions/tool-effect-reading`).
 *
 *   npx tsx --tsconfig tsconfig.app.json scripts/test-tool-effects.ts            check
 *   npx tsx --tsconfig tsconfig.app.json scripts/test-tool-effects.ts --update   accept what the readers report now
 *
 * - Each harness's cases (`fixtures/tool-effects/<harness>.json`, shapes from
 *   its real records with their content neutralized) go through the shared
 *   projection its live decoder and history reader both run, and each call's
 *   effects and status must be the ones the case expects.
 * - Every kept decoder pair (`fixtures/native-decoding/<harness>/pairs`)
 *   must report the same effects live and from each store, apart from the
 *   differences listed below with why they stay. A harness whose live
 *   decoder reports no effects at all yet is named, not failed.
 * - The reading's own rules: command lines, patches, paths, the saved
 *   accessor and the live engine's hook.
 */

const { values: options } = parseArgs({ options: { update: { type: "boolean", default: false } } })
const CASES_ROOT = join(import.meta.dirname, "fixtures", "tool-effects")
const failures: string[] = []

/* ------------------------------------------------------ harness cases */

const CallResult = z.object({ status: z.string(), effects: z.array(z.json()) })
const CaseSchema = z.object({
  about: z.string(),
  records: z.array(z.json()).optional(),
  calls: z.array(z.object({ id: z.string(), name: z.string(), input: z.json(), end: z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })), metadata: z.json().optional() }) })).optional(),
  finish: z.enum(["finished", "cancelled", "error"]).optional(),
  expected: z.record(z.string(), CallResult).optional(),
})
const CasesSchema = z.object({ harness: z.string(), source: z.string(), cwd: z.string().optional(), cases: z.array(CaseSchema).min(1) }).loose()
type Case = z.infer<typeof CaseSchema>

/** Each finished call's effects and status, by call id, as the harness's shared projection reports them. */
function projected(harness: string, cwd: string | undefined, test: Case): Map<string, { status: ToolEffects["status"]; effects: ToolEffect[] }> {
  const calls = new Map<string, { status: ToolEffects["status"]; effects: ToolEffect[] }>()
  for (const block of reduceLiveUpdates([], projectedUpdates(harness, cwd, test)))
    if (block.type === "tool" && block.effects) calls.set(block.id, { status: liveEffectsStatus(harness, block), effects: block.effects })
  return calls
}

function projectedUpdates(harness: string, cwd: string | undefined, test: Case): LiveUpdate[] {
  const records = test.records ?? []
  switch (harness) {
    case "claude": {
      const projection = new ClaudeProjection()
      projection.at(cwd)
      // SAFETY: each case records SDK messages as the SDK yielded them and Claude saved them.
      return records.flatMap((record) => projection.project(record as SDKMessage))
    }
    case "cursor": {
      const projection = new CursorSdkProjection("turn")
      const updates = records.flatMap((record) => projection.message(CursorSdkMessageSchema.parse(record)))
      const outcome: CursorTurnOutcome | undefined = test.finish
      if (outcome) updates.push(...projection.finish(outcome, cursorUnfinishedToolNote(outcome)))
      return updates
    }
    case "grok":
    case "devin": {
      const decoder = new AcpUpdateDecoder(harness === "grok" ? GROK_ACP_HOOKS : DEVIN_ACP_HOOKS)
      return records.flatMap((record) => {
        const notification = acpSavedNotification({ sessionId: "s", update: SavedAcpUpdateSchema.parse(record) })
        return notification ? decoder.update(notification).flatMap((item) => item.kind === "update" ? [item.update] : []) : []
      })
    }
    case "opencode": {
      const content = new OpenCodeContent("root", cwd ?? "/")
      return (test.calls ?? []).flatMap((call) => [
        ...content.toolStarted("root", call.id, call.name),
        ...content.toolCalled("root", call.id, call.input),
        ...content.toolEnded("root", call.id, call.end),
      ])
    }
    default:
      throw new Error(`No cases runner for ${harness}`)
  }
}

let cases = 0
for (const name of (await readdir(CASES_ROOT)).filter((file) => file.endsWith(".json")).sort()) {
  const path = join(CASES_ROOT, name)
  const fixture = CasesSchema.parse(JSON.parse(await readFile(path, "utf8")))
  let changed = false
  for (const test of fixture.cases) {
    cases++
    const actual = JSON.parse(JSON.stringify(Object.fromEntries(projected(fixture.harness, fixture.cwd, test))))
    if (options.update) {
      if (!isDeepStrictEqual(test.expected, actual)) changed = true
      test.expected = actual
    } else if (!test.expected) failures.push(`${fixture.harness}: "${test.about}" has no expected effects yet; run with --update and review them`)
    else if (!isDeepStrictEqual(test.expected, actual))
      failures.push(`${fixture.harness}: "${test.about}"\n    expected ${JSON.stringify(test.expected)}\n    reported ${JSON.stringify(actual)}`)
  }
  if (changed) {
    await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`)
    console.log(`updated ${name}; review the expected effects`)
  }
}

/* ------------------------------------------------------- decoder pairs */

/**
 * Differences between what a pair's live wire and a store report, each
 * because the harness keeps other than it streamed: less, or what came after
 * the wire ended. `-` is reported only live, `+` only from the store.
 */
const KNOWN: readonly { pair: string; reader: string; side: "-" | "+"; effects: string; reason: string }[] =
  ["devin", "devin-ide"].flatMap((reader) => [
    {
      pair: "devin/stopped-shell", reader, side: "-" as const,
      effects: '[{"kind":"command","command":"tail -f notes.md","cwd":"/tmp/mako-pair/project"}]',
      reason: "Devin 3000.11.205 names a command's folder (`cognition.ai/cwd`) in an update it sends while the command runs; for a stopped command its store keeps only the call and its cancellation, neither of which names it.",
    },
    {
      pair: "devin/stopped-shell", reader, side: "+" as const,
      effects: '[{"kind":"command","command":"tail -f notes.md"}]',
      reason: "The same command read from the store, without the folder.",
    },
    {
      pair: "devin/steered-shell", reader, side: "-" as const,
      effects: '[{"kind":"command","command":"sleep 3","cwd":"/tmp/mako-pair/project","exitCode":0}]',
      reason: "When a message is steered into a running command, Devin 3000.11.205 moves the command to the background; live, it still named the command's folder and, once it ended, its exit.",
    },
    {
      pair: "devin/steered-shell", reader, side: "+" as const,
      effects: '[{"kind":"command","command":"sleep 3"}]',
      reason: "What Devin 3000.11.205 keeps of a command moved to the background is the model's word for it, which names neither its folder nor how it ended.",
    },
  ])

/** A side's calls that report effects, each as its effects' JSON, in order. */
const effectLines = (blocks: readonly { effects?: ToolEffect[] }[]) => blocks.flatMap((block) => block.effects?.length ? [JSON.stringify(block.effects)] : [])

/** What one side reports that the other doesn't, counting repeats; the order calls end in can differ between the wire and a store. */
function unmatched(left: readonly string[], right: readonly string[]): string[] {
  const rest = [...right]
  return left.filter((line) => {
    const at = rest.indexOf(line)
    if (at < 0) return true
    rest.splice(at, 1)
    return false
  })
}

let pairs = 0
const silentLive = new Map<string, number>()
const usedKnown = new Set<(typeof KNOWN)[number]>()
for (const harness of (await readdir(FIXTURE_ROOT)).sort()) {
  const root = join(FIXTURE_ROOT, harness, PAIRS_FOLDER)
  const found: string[] = []
  let liveReports = false
  for (const name of (await readdir(root).catch(() => [])).sort()) {
    const folder = join(root, name)
    const pair = PairSchema.parse(JSON.parse(await readFile(join(folder, "pair.json"), "utf8")))
    const recording = await readRecording(join(folder, "capture.jsonl"))
    const live = effectLines(reduceLiveUpdates([], liveUpdates(pair.harness, recording)).flatMap((block) => block.type === "tool" ? [block] : []))
    if (live.length) liveReports = true
    for (const store of pair.stores) {
      pairs++
      const thread = await storeReader(store.reader, join(folder, "home")).read(join(folder, "home", store.path))
      const saved = effectLines((thread?.entries ?? []).flatMap((entry) => entry.type === "tool" ? [entry] : []))
      const differences = [
        ...unmatched(live, saved).map((effects) => ({ side: "-" as const, effects })),
        ...unmatched(saved, live).map((effects) => ({ side: "+" as const, effects })),
      ]
      for (const difference of differences) {
        const known = KNOWN.find((entry) => entry.pair === `${harness}/${name}` && entry.reader === store.reader && entry.side === difference.side && entry.effects === difference.effects)
        if (known) usedKnown.add(known)
        else found.push(`${harness}/${name} ${store.reader} ${difference.side} ${difference.effects}`)
      }
    }
  }
  if (!found.length) continue
  if (liveReports) failures.push(`live and saved report different effects:\n${found.map((line) => `    ${line}`).join("\n")}`)
  else silentLive.set(harness, found.length)
}
for (const known of KNOWN) if (!usedKnown.has(known)) failures.push(`listed, but both sides now agree; drop it: ${known.pair} ${known.reader} ${known.side} ${known.effects}`)

/* ---------------------------------------------------------- the rules */

const cwd = "/Users/me/project"
assert.deepEqual(namedPaths("echo hi > ../outside.txt", cwd), ["/Users/me/outside.txt"], "a redirect's target is named, resolved against the folder")
assert.deepEqual(namedPaths("cat a.txt 2>/dev/null >> log/out.txt", cwd), ["/Users/me/project/log/out.txt"], "devices aren't paths; an append is a write")
assert.deepEqual(namedPaths("rm -rf dist build && mkdir -p dist", cwd), ["/Users/me/project/dist", "/Users/me/project/build"], "rm and mkdir operands, options left out, each path once")
assert.deepEqual(namedPaths("mv 'old name.md' new.md; cp -r src /tmp/copy", cwd), ["/Users/me/project/old name.md", "/Users/me/project/new.md", "/Users/me/project/src", "/tmp/copy"], "quotes are removed")
assert.deepEqual(namedPaths("sed -i '' 's/a/b/' notes.md other.md", cwd), ["/Users/me/project/notes.md", "/Users/me/project/other.md"], "sed -i edits the operands after its script")
assert.deepEqual(namedPaths("sed -i -e 's/a/b/' -e 's/c/d/' notes.md", cwd), ["/Users/me/project/notes.md"], "with -e every operand is a file")
assert.deepEqual(namedPaths("perl -pi -e 's/a/b/' notes.md", cwd), ["/Users/me/project/notes.md"])
assert.deepEqual(namedPaths("sed -n '1,5p' notes.md", cwd), [], "sed without -i writes nothing")
assert.deepEqual(namedPaths("npm test | tee -a test.log", cwd), ["/Users/me/project/test.log"])
assert.deepEqual(namedPaths("git mv a.ts b.ts && git rm -q c.ts", cwd), ["/Users/me/project/a.ts", "/Users/me/project/b.ts", "/Users/me/project/c.ts"])
assert.deepEqual(namedPaths("git checkout HEAD~1 -- src/a.ts && git restore --source main -- b.ts c.ts", cwd), ["/Users/me/project/src/a.ts", "/Users/me/project/b.ts", "/Users/me/project/c.ts"], "files Git puts back by name")
assert.deepEqual(namedPaths("git checkout feature && git restore --staged d.ts", cwd), [], "a branch switch names no file; restoring only the index writes none")
assert.deepEqual(namedPaths("cd packages/app && touch ready", cwd), ["/Users/me/project/packages/app/ready"], "a cd into a known folder moves where relative paths resolve")
assert.deepEqual(namedPaths("cd \"$DIR\" && touch ready && touch /tmp/abs", cwd), ["/tmp/abs"], "after a cd into an unknown folder only absolute paths are named")
assert.deepEqual(namedPaths("rm $HOME/x *.log ~/y `pwd`/z", cwd), [], "words the shell expands are left out")
assert.deepEqual(namedPaths("cat > notes.md <<'EOF'\nrm -rf /\n> not a redirect\nEOF\ntouch done", cwd), ["/Users/me/project/notes.md", "/Users/me/project/done"], "a heredoc's body is not commands")
assert.deepEqual(namedPaths("sudo FOO=1 rm -- -weird", cwd), ["/Users/me/project/-weird"], "prefixes and assignments go; after -- an operand may start with a dash")
assert.deepEqual(namedPaths("touch a # rm b", cwd), ["/Users/me/project/a"], "a comment is not a command")
assert.deepEqual(namedPaths("touch notes.md", undefined), [], "a relative path without a folder is left out")

const file = (path: string, shell?: boolean, folder = cwd) => ({ kind: "file", path, cwd: folder, ...(shell !== undefined && { shell }) })
assert.deepEqual(scriptRuns("python3 draw.py", cwd), [file("/Users/me/project/draw.py", false)], "an interpreter runs the file its first operand names")
assert.deepEqual(scriptRuns("cd tools && .venv/bin/python -u -W ignore plot.py > plot.log 2>&1", cwd), [file("/Users/me/project/tools/plot.py", false, "/Users/me/project/tools")], "options and their values, redirects, a cd and an interpreter by its path")
assert.deepEqual(scriptRuns("npx tsx --tsconfig tsconfig.app.json scripts/gen.ts && uv run report.py && poetry run python a.py", cwd), [file("/Users/me/project/scripts/gen.ts", false), file("/Users/me/project/report.py", false), file("/Users/me/project/a.py", false)], "runners that run a program, or a Python file")
assert.deepEqual(scriptRuns("timeout 60 env DEBUG=1 node --import tsx build.mjs; bash gen.sh; source env.sh", cwd), [file("/Users/me/project/build.mjs", false), file("/Users/me/project/gen.sh", true), file("/Users/me/project/env.sh", true)], "prefixes go; a shell's script is commands too")
assert.deepEqual(scriptRuns("bash -lc 'python3 draw.py' && ./gen.sh --fast && scripts/x", cwd), [file("/Users/me/project/draw.py", false), file("/Users/me/project/gen.sh"), file("/Users/me/project/scripts/x")], "a shell's own line, and programs run by their path, whose first line says what runs them")
assert.deepEqual(scriptRuns("npm run -s gen -- --x && npm test && pnpm gen && yarn gen && bun run gen && bun x.ts", cwd), [
  { kind: "package", manager: "npm", script: "gen", cwd },
  { kind: "package", manager: "npm", script: "test", cwd },
  { kind: "package", manager: "pnpm", script: "gen", cwd },
  { kind: "package", manager: "yarn", script: "gen", cwd },
  { kind: "package", manager: "bun", script: "gen", cwd },
  file("/Users/me/project/x.ts", false),
], "package scripts by each manager, and a file bun runs itself")
assert.deepEqual(scriptRuns("make && make -C docs -j 4 html && make -f build.mk tide.png", cwd), [
  { kind: "make", cwd, targets: [] },
  { kind: "make", cwd: "/Users/me/project/docs", targets: ["html"] },
  { kind: "make", cwd, makefile: "/Users/me/project/build.mk", targets: ["tide.png"] },
], "Make's folder, Makefile and goals")
for (const command of ["python3 -m http.server", "python3 - <<'EOF'\nopen('a.txt', 'w')\nEOF", "python3 -c 'print(1)'", "node -e 1", "python3 $SCRIPT", "cd \"$DIR\" && python3 x.py", "npm install", "npm run gen -w app", "pnpm --filter app gen", "yarn add left-pad", "bun test", "make -n all", "npx eslint .", "gen.sh", "deno task gen"])
  assert.deepEqual(scriptRuns(command, cwd), [], `runs no file it can place: ${command}`)
assert.deepEqual(scriptRuns("python3 draw.py", undefined), [], "a relative script without a folder is left out")

assert.equal(absolutePath("file:///Users/me/a%20b.md", undefined), "/Users/me/a b.md")
assert.equal(absolutePath("https://example.com/a", cwd), undefined)
assert.equal(absolutePath("./src/../lib/x.ts", cwd), "/Users/me/project/lib/x.ts")

assert.equal(wholePatch("a\nb\nc\n", "a\nB\nc\n"), "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n")
assert.equal(wholePatch("", "x\n"), "@@ -0,0 +1,1 @@\n+x\n", "a file from nothing adds every line")
assert.equal(wholePatch("x\n", "x"), "@@ -1,1 +1,1 @@\n-x\n+x\n\\ No newline at end of file\n", "a lost final newline is a change")
assert.equal(wholePatch("same\n", "same\n"), undefined)
const long = Array.from({ length: 20 }, (_, index) => `line ${index}`)
assert.equal(wholePatch(`${long.join("\n")}\n`, `${long.map((line, index) => index === 10 ? "changed" : line).join("\n")}\n`),
  "@@ -8,7 +8,7 @@\n line 7\n line 8\n line 9\n-line 10\n+changed\n line 11\n line 12\n line 13\n", "three lines of context either side")

assert.deepEqual(reportedEffects({ harness: "opencode", name: "patch", args: { patchText: "--- a/x.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+n\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-g\n" }, cwd }), [
  { kind: "rename", from: "/Users/me/project/x.ts", to: "/Users/me/project/y.ts" },
  { kind: "modify", path: "/Users/me/project/y.ts", patch: "@@ -1 +1 @@\n-a\n+b\n" },
  { kind: "create", path: "/Users/me/project/new.ts", content: "n\n" },
  { kind: "delete", path: "/Users/me/project/gone.ts" },
], "a unified diff of several files: each file's change, a rename where the paths differ")
assert.deepEqual(reportedEffects({ harness: "claude", name: "Write", args: { file_path: "a.md", content: "x".repeat(300_000) }, cwd }), [{ kind: "write", path: "/Users/me/project/a.md" }],
  "content over the limit is left out of the effect, never cut")
assert.deepEqual(reportedEffects({ harness: "grok", name: "use_tool", input: JSON.stringify({ tool_name: "search_replace", tool_input: { file_path: "/a.md", old_string: "x", new_string: "" } }) }),
  [{ kind: "modify", path: "/a.md", edits: [{ old: "x", new: "" }] }], "a wrapped tool reads as the tool it ran; an empty replacement is an edit")

// Saved history whose reader records no effects reads them from the call.
const callsAt = Date.parse("2026-10-12T00:00:00.000Z")
const saved = savedToolEffects("cursor", [
  { type: "tool", id: "t1", at: callsAt, name: "StrReplace", status: "completed", input: JSON.stringify({ path: "src/a.ts", old_string: "1", new_string: "2" }), output: "ok" },
  { type: "tool", id: "t2", at: callsAt, name: "Shell", status: "failed", input: JSON.stringify({ command: "touch x" }), output: "Cursor did not run this call." },
  { type: "tool", id: "t3", at: callsAt, name: "updateTodos", input: "{}" },
  { type: "text", id: "a1", text: "untimed" },
  { type: "text", id: "a2", at: Date.parse("2026-10-12T00:00:30.000Z"), text: "next" },
], cwd)
// A finished call's record keeps no end: it had ended by the next entry with a time. One still running hasn't.
assert.deepEqual(saved, [
  { callId: "t1", status: "completed", startedAt: Date.parse("2026-10-12T00:00:00.000Z"), endedAt: Date.parse("2026-10-12T00:00:30.000Z"), effects: [{ kind: "modify", path: "/Users/me/project/src/a.ts", edits: [{ old: "1", new: "2" }] }] },
  { callId: "t2", status: "refused", startedAt: Date.parse("2026-10-12T00:00:00.000Z"), endedAt: Date.parse("2026-10-12T00:00:30.000Z"), effects: [{ kind: "command", command: "touch x", cwd, named: ["/Users/me/project/x"] }] },
  { callId: "t3", status: "running", startedAt: Date.parse("2026-10-12T00:00:00.000Z"), effects: [] },
] satisfies ToolEffects[])

// The live engine hands each finished call's effects to its hook, once, when the call ends.
const handed: ToolEffects[] = []
const engine = createLiveEngine<EngineLive>({ effects: (_live, call) => handed.push(call) })
const state: LiveSessionState = { id: "c", harness: "claude", nativeId: "n", cwd, title: "", status: "running", connection: "connected", modes: [], currentMode: null, configOptions: [] }
const events: LiveDriverEvent[] = []
const live: EngineLive = { state, emit: (event) => events.push(event) }
const effects: ToolEffect[] = [{ kind: "read", path: "/Users/me/project/a.md" }]
engine.emitUpdate(live, { kind: "tool", id: "call", title: "Read", name: "Read", status: "running" })
engine.emitUpdates(live, [{ kind: "tool-update", id: "call", status: "completed", output: "1\ta", effects }, { kind: "text", text: "done" }])
assert.equal(handed.length, 1)
assert.equal(handed[0]!.callId, "call")
assert.equal(handed[0]!.status, "completed")
assert.deepEqual(handed[0]!.effects, effects)
assert.ok(handed[0]!.startedAt !== undefined && handed[0]!.endedAt !== undefined && handed[0]!.endedAt >= handed[0]!.startedAt)
assert.equal(events.length, 2, "the hook changes nothing the session emits")

// Each call leaves the engine with when the host first saw it and first saw it finished.
const timedEvents: LiveDriverEvent[] = []
const timedLive: EngineLive = { state: { ...state, id: "timed" }, emit: (event) => timedEvents.push(event) }
const clock = mock.method(Date, "now", () => 1_000)
engine.emitUpdate(timedLive, { kind: "tool", id: "timed", title: "Bash", status: "running" })
clock.mock.mockImplementation(() => 4_000)
engine.emitUpdate(timedLive, { kind: "tool-update", id: "timed", status: "completed", output: "a" })
clock.mock.mockImplementation(() => 9_000)
engine.emitUpdate(timedLive, { kind: "tool-update", id: "timed", status: "completed", outputAppend: "b" })
engine.emitUpdate(timedLive, { kind: "tool", id: "timed", title: "Bash", status: "completed", output: "ab" })
clock.mock.restore()
const timedUpdates = timedEvents.flatMap((event) => event.type === "live-update" ? [event.update] : [])
const timedBlock = reduceLiveUpdates([], timedUpdates)[0]
assert.equal(timedBlock?.type, "tool")
assert.deepEqual([timedBlock.at, timedBlock.endedAt], [1_000, 4_000],
  "a call keeps its first start and first end, however often its harness restates it")
const afterEnd = deliverLiveUpdates(reduceLiveUpdates([], timedUpdates.slice(0, 2)), timedUpdates.slice(2, 3))
assert.deepEqual(afterEnd.grown.get(0), { output: "b" }, "output a finished call still streams stays an append in storage")

if (failures.length) {
  console.error(`\n${failures.map((failure) => `✗ ${failure}`).join("\n\n")}\n`)
  process.exit(1)
}
const silent = [...silentLive].map(([harness, count]) => `${harness} (${count} differences: its live decoder reports no effects yet)`)
console.log(`PASS: ${cases} cases report their calls' effects through each harness's shared projection; ${pairs} pair stores report the same effects as their live wire${KNOWN.length ? `, ${usedKnown.size} known differences` : ""}${silent.length ? `; not yet compared: ${silent.join(", ")}` : ""}; command lines, patches, paths, the saved accessor and the live hook read as stated`)
