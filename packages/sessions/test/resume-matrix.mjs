/**
 * The resume matrix: every emitter, proven by the reader that matters.
 *
 * For each target harness, a canonical conversation is emitted into a
 * scratch home, then read back with that harness's OWN provider — the same
 * code that reads real stores. What this proves is the property the whole
 * feature stands on: an emitted session is not merely a file in the right
 * folder, it is a session the target's tooling genuinely parses, with the
 * conversation intact.
 *
 * Fidelity bar (the flatten() contract): every user turn's text survives
 * verbatim; assistant text survives; tool activity is represented (the
 * emitters deliberately fold tool calls into text — portable beats
 * structured-but-rejected); the working directory rides along. Live-CLI
 * resume was proven by hand once per harness; this guards the read-back
 * half on every change, with no CLI or network involved.
 *
 * Run: npm run test:matrix   (from packages/sessions, after a build)
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  emitClaudeSession,
  emitCodexSession,
  emitCursorSession,
  emitGrokSession,
} from "../dist/emit.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { GrokProvider } from "../dist/providers/grok.js"
import { entriesFromMessages } from "../dist/entry-sink.js"
import { NativeStores } from "../dist/read-only-sqlite.js"

const nativeStores = new NativeStores(false)

const FACT = "the deploy key is lyrebird-kingfisher-42"
const CWD = "/tmp/matrix-project"

/** A conversation that exercises every entry kind the emitters flatten. */
const source = {
  ref: {
    harness: "codex",
    nativeId: "matrix-src-1",
    path: "/tmp/matrix-src.jsonl",
    cwd: CWD,
    title: "Resume matrix source",
    startedAt: "2026-08-18T10:00:00.000Z",
    updatedAt: "2026-08-18T10:05:00.000Z",
  },
  entries: entriesFromMessages([
    { kind: "user", at: "2026-08-18T10:00:00.000Z", text: `Remember this: ${FACT}. Also — unicode survives: café, 中文, 🦈.` },
    {
      kind: "assistant",
      at: "2026-08-18T10:00:10.000Z",
      blocks: [
        { type: "thinking", text: "Note the fact, check the repo." },
        {
          type: "tool",
          name: "bash",
          input: "rg -n 'deploy' src/",
          output: "src/deploy.ts:12",
          error: true,
        },
        { type: "text", text: "Noted. The deploy path runs through src/deploy.ts." },
      ],
    },
    { kind: "event", at: "2026-08-18T10:01:00.000Z", label: "Model changed", detail: "gpt-5.6-sol" },
    { kind: "user", at: "2026-08-18T10:02:00.000Z", text: "What was the deploy key I told you?" },
    {
      kind: "assistant",
      at: "2026-08-18T10:02:05.000Z",
      blocks: [{ type: "text", text: `You said ${FACT}.` }],
    },
  ]),
}

const MATRIX = [
  { name: "claude", emit: emitClaudeSession, provider: (home) => new ClaudeProvider(home) },
  { name: "codex", emit: emitCodexSession, provider: (home) => new CodexProvider(nativeStores, home) },
  { name: "grok", emit: emitGrokSession, provider: (home) => new GrokProvider(home) },
  { name: "cursor", emit: emitCursorSession, provider: (home) => new CursorProvider(nativeStores, home) },
]

const textOf = (entries) =>
  entries
    .map((entry) =>
      entry.type === "event"
        ? `${entry.label} ${entry.detail ?? ""}`
        : [entry.text, entry.name, entry.input, entry.output].filter(Boolean).join(" ")
    )
    .join("\n")

let failures = 0
const report = []

for (const target of MATRIX) {
  const home = mkdtempSync(join(tmpdir(), `matrix-${target.name}-`))
  const checks = {}
  try {
    const emitted = await target.emit(nativeStores, source, { cwd: CWD, home })
    checks.emitted = Boolean(emitted?.path)

    const provider = target.provider(home)
    const files = await provider.discover()
    checks.discovered = files.length >= 1

    const file = files.find((f) => f.path === emitted.path) ?? files[0]
    const ref = await provider.peek(file)
    checks.peeked = Boolean(ref)
    checks.cwd = ref?.cwd === CWD

    const thread = await provider.read(file.path)
    checks.read = Boolean(thread && thread.entries.length > 0)
    const text = thread ? textOf(thread.entries) : ""
    checks.userVerbatim =
      text.includes(FACT) &&
      text.includes("café, 中文, 🦈") &&
      text.includes("What was the deploy key I told you?")
    checks.assistantText = text.includes("runs through src/deploy.ts")
    checks.toolRepresented = text.includes("rg -n 'deploy' src/") || text.includes("bash")
    checks.toolError = text.includes("[tool: bash — failed]")
    checks.recall = text.includes(`You said ${FACT}`)
    checks.userTurnCount =
      (thread?.entries ?? []).filter((entry) => entry.type === "user").length === 2
  } catch (error) {
    checks.error = String(error).slice(0, 140)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }

  const failed = Object.entries(checks).filter(([key, ok]) => key !== "error" && ok !== true)
  if (failed.length > 0 || checks.error) failures++
  report.push({ target: target.name, ...checks })
}

for (const row of report) {
  const { target, error, ...checks } = row
  const bad = Object.entries(checks).filter(([, ok]) => ok !== true).map(([key]) => key)
  console.log(
    bad.length === 0 && !error
      ? `  ✓ ${target.padEnd(7)} emit → provider read-back: portable replay fidelity`
      : `  ✗ ${target.padEnd(7)} FAILED: ${error ?? bad.join(", ")}`
  )
}

if (failures > 0) {
  console.error(`\n${failures} target(s) failed the resume matrix.`)
  process.exit(1)
}
console.log("\nResume matrix clean: every imported session preserves the portable replay contract.")
