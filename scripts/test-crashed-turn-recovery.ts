import assert from "node:assert/strict"
import { withoutMakoFraming } from "@mako/sessions"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { NativeTurnOutcome } from "@mako/host/harnesses/native-turn"
import { readClaudeTurn } from "@mako/host/harnesses/claude/turn-outcome"
import { readCodexTurn } from "@mako/host/harnesses/codex/turn-outcome"
import { AgentsWorld, TESTED_HARNESSES } from "./lib/agents-world.ts"

async function until(test: () => boolean, why: string) {
  const deadline = performance.now() + 8_000
  while (!test()) {
    assert.ok(performance.now() < deadline, why)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const requested = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7)
const MODES = (["unfinished", "completed", "off", "stop-in-read", "off-in-read", "retry", "queued", "completed-queued", "completed-unreadable", "unknown", "context-only", "no-native-id"] as const).filter((mode) => !requested || mode === requested)
assert.ok(MODES.length, "unknown fixture case")

if (process.argv[2] === "child") {
  const base = process.argv[3]!
  const harness = process.argv[4]!
  for (const mode of MODES) {
    const root = join(base, `${harness}-${mode}`)
    mkdirSync(root, { recursive: true })
    const world = new AgentsWorld({ root, script: (turn) => turn.world.hold(turn.conversation).then(() => "Original finished"),
      heard: (heard) => {
        if (mode !== "no-native-id") return
        const snapshot = world.live.snapshot(heard.conversation)!
        assert.equal(snapshot.requests.at(-1)?.nativeRun, undefined)
        writeFileSync(join(root, "state.json"), JSON.stringify({ conversation: heard.conversation, request: snapshot.requests.at(-1)!.id, snapshot }))
        process.kill(process.pid, "SIGKILL")
      } })
    const { conversation } = await world.apex(harness, "full")
    if (mode === "off") world.live.setConversationSettings({ continueAfterRestart: false })
    const request = world.say(conversation, "Original")
    await until(() => !!world.live.snapshot(conversation)?.requests.find((row) => row.id === request)?.nativeRun, "native run was not retained")
    if (mode === "queued" || mode === "completed-queued") { world.say(conversation, "After one"); world.say(conversation, "After two") }
    await new Promise((resolve) => setTimeout(resolve, 100))
    const snapshot = world.live.snapshot(conversation)!
    writeFileSync(join(root, "state.json"), JSON.stringify({ conversation, request, snapshot }))
  }
  process.kill(process.pid, "SIGKILL")
  await new Promise(() => {})
} else {
  const root = mkdtempSync(join(tmpdir(), "mako-crash-recovery-"))
  try {
    for (const harness of TESTED_HARNESSES) {
      const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "child", root, harness, ...requested ? [`--case=${requested}`] : []], { stdio: ["ignore", "ignore", "pipe"] })
      let stderr = ""
      child.stderr.on("data", (chunk) => { stderr += String(chunk) })
      await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => signal === "SIGKILL" ? resolve() : reject(new Error(`fixture exit ${code}/${signal}: ${stderr}`))) })
      for (const mode of MODES) {
        const place = join(root, `${harness}-${mode}`)
        const state = JSON.parse(readFileSync(join(place, "state.json"), "utf8"))
        const binding = state.snapshot.control.bindings.find((row: { id: string }) => row.id === state.snapshot.control.activeBindingId)
        const runId = state.snapshot.requests.find((row: { id: string }) => row.id === state.request).nativeRun?.runId
        mkdirSync(dirname(binding.path), { recursive: true })
        const rows = harness === "codex"
          ? [{ type: "session_meta", payload: { id: binding.nativeId } }, { type: "event_msg", payload: { type: "task_started", turn_id: runId } }, ...mode.startsWith("completed") ? [{ type: "event_msg", payload: { type: "task_complete", turn_id: runId } }] : []]
          : [{ type: "user", uuid: runId, sessionId: binding.nativeId, message: { content: "Original" } }, ...mode.startsWith("completed") ? [{ type: "assistant", uuid: "answer", parentUuid: runId, sessionId: binding.nativeId, message: { content: [], stop_reason: "end_turn" } }] : []]
        writeFileSync(binding.path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
        let reads = 0
        let inspections = 0
        let enter!: () => void
        const entered = new Promise<void>((resolve) => { enter = resolve })
        let release!: () => void
        const held = new Promise<void>((resolve) => { release = resolve })
        const nativeRef = { harness, nativeId: binding.nativeId, path: binding.path }
        const world = new AgentsWorld({ root: place, autoContinueDelayMs: 10, script: () => "Recovered",
          catalog: { nativePath: () => binding.path, ref: () => nativeRef, activity: () => ({}), subscribe: () => () => {}, announce: () => {}, page: async () => mode === "completed-unreadable" ? null : ({ ref: nativeRef,
            entries: [{ type: "user", id: "native-input", text: "Original" }, { type: "text", id: "native-answer", text: "Saved native result" }],
            start: 0, total: 2, hasEarlier: false }) },
          nativeInspection: async (saved) => {
            inspections += 1
            assert.equal(saved.path, binding.path)
            assert.ok(readFileSync(saved.path!, "utf8").length > 0)
            return { kind: "available", checkpoint: "scripted-consistent-native-read", strategy: "same-session" }
          },
          nativeTurn: mode === "context-only" ? false : async (target): Promise<NativeTurnOutcome> => {
            reads += 1
            enter()
            if (mode.endsWith("in-read")) await held
            if (mode === "retry" && reads === 1) return { kind: "unavailable", reason: "Synthetic record temporarily unavailable" }
            assert.equal(target.binding.nativeId, binding.nativeId)
            assert.equal(target.runId, runId)
            if (mode === "unknown") return { kind: "unknown", reason: "Source verified; exact turn outcome unknown" }
            if (harness === "codex") return readCodexTurn(target)
            if (harness === "claude") return readClaudeTurn(target)
            return { kind: mode.startsWith("completed") ? "completed" : "unfinished" }
          } })
        try {
          if (mode === "off") {
            await new Promise((resolve) => setTimeout(resolve, 150))
            assert.equal(reads, 0)
            assert.equal(world.prompts.length, 0)
          } else if (mode.endsWith("in-read")) {
            await Promise.race([entered, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("native read was not reached")), 8_000))])
            assert.equal(world.starts.length, 0, "the native read precedes opening a provider")
            if (mode === "stop-in-read") await world.live.cancel(state.conversation)
            else world.live.setConversationSettings({ continueAfterRestart: false })
            release()
            await new Promise((resolve) => setTimeout(resolve, 150))
            assert.equal(world.prompts.length, 0)
            assert.equal(world.starts.length, 0, "a stale native read cannot bypass Stop")
          } else if (mode.startsWith("completed") && mode !== "completed-unreadable") {
            await until(() => world.live.snapshot(state.conversation)?.requests.find((row) => row.id === state.request)?.status === "completed", `${harness}: completion was not reconciled`)
            const snapshot = world.live.snapshot(state.conversation)!
            assert.equal(snapshot.session.error, undefined, "native completion clears the obsolete crash error")
            assert.equal(snapshot.session.status, "ready")
            assert.ok(snapshot.control?.transfers.every((transfer) => transfer.state.kind !== "preparing" && transfer.state.kind !== "queued"), "completed work leaves no retry or busy transfer loop")
            assert.ok(snapshot.base?.entries.some((entry) => entry.type === "text" && entry.text === "Saved native result"), "completion suppresses a new turn only after its saved answer is visible")
            if (mode === "completed-queued") {
              await until(() => world.prompts.length === 2, "native completion must not strand its queued messages")
              assert.deepEqual(world.prompts.map((row) => row.text), ["After one", "After two"])
            } else {
              assert.equal(world.starts.length, 0, "native completion needs no new provider process")
              assert.equal(world.prompts.length, 0)
            }
          } else {
            if (mode === "retry") {
              await until(() => !!world.live.snapshot(state.conversation)?.control?.transfers.some((row) => row.retry), "native verification did not keep its bounded retry")
              assert.equal(world.starts.length, 0)
              const retry = world.live.snapshot(state.conversation)!.control!.transfers.find((row) => row.retry)!.retry!
              assert.equal(retry.cause, "launch-stalled")
              world.live.wakeDue(retry.at)
            }
            await until(() => world.prompts.length === (mode === "queued" ? 3 : 1), `${harness}/${mode}: crash continuation did not run`)
            assert.ok(withoutMakoFraming(world.prompts[0]!.text).startsWith("Continue where you left off."))
            assert.match(world.prompts[0]!.text, /check the result of any command or edit before repeating/)
            assert.ok(inspections > 0, "even an unknown outcome first reads the verified native source")
            if (mode === "no-native-id" || mode === "context-only") assert.equal(reads, 0, "no claim of exact outcome without native correspondence")
            if (mode === "no-native-id") {
              const continuation = world.live.snapshot(state.conversation)!.requests.find((row) => row.continues?.requestId === state.request)!
              assert.equal(continuation.continues?.brief, undefined, "an uncertain brief is not reactivated")
              assert.ok(continuation.context?.some((manifest) => readFileSync(manifest.file, "utf8").includes("Original")), "the original objective remains available as retained history")
            }
            assert.equal(world.prompts.some((row) => row.text === "Original"), false, "an accepted original is never replayed")
            if (mode === "queued") assert.deepEqual(world.prompts.slice(1).map((row) => row.text), ["After one", "After two"])
          }
        } finally { release(); await world.close() }
      }
    }
    console.log("PASS: real host-process crashes reconcile exact native turns before opening, suppress completed work, retry temporary reads and retain Stop/Off/FIFO")
  } finally { rmSync(root, { recursive: true, force: true }) }
}
