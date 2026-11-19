import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NativeVerificationPendingError } from "@mako/host/contracts/native-verification"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { STRANDED_AFTER_MS } from "@mako/host/contracts/turn-continuation"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * The question a Fin's Apex hears when the Fin's turn was cut short and nothing continues it ("Its turn was cut
 * short. Continue it, give it other words, or stop it?") is written only for a cut Mako doesn't continue itself, so
 * every report in the store reaches its Apex exactly once (`Agents.watchCut`, `Agents.checkCut`).
 *
 * A host is killed (SIGKILL) as a Fin's harness takes its brief. The next host continues the cut turn itself: a
 * reconnect that first verifies the native turn (`reconcileCut`). Once, the question was written `STRANDED_AFTER_MS`
 * after the cut while that continuation was not yet admitted, or still being verified, and the turn then went on: the
 * question was dropped as stale and no digest ever carried it, a stored report its Apex never heard (`test:orch-crash`'s
 * `lone` failed on it once in six runs on a slow runner). Four endings:
 *
 * - `continued`: the continuation is refused as the host takes the Fin up (a conversation not read in yet, or busy for
 *   that moment, refuses it) and can be admitted by the time the cut is looked at: it is, no question is ever written,
 *   the Fin finishes, and each of its reports is in exactly one digest;
 * - `asked`: it still can't be admitted: the question is written once, and its Apex hears it in exactly one digest;
 * - `verified`: the native check can't finish at first (`NativeVerificationPendingError`, tried again soon), then runs
 *   well past `STRANDED_AFTER_MS`, and passes: nothing is asked meanwhile or after, and the turn goes on;
 * - `unverified`: the same, and it fails, so nothing continues the turn: nothing is asked while it ran, and the question
 *   is written once `STRANDED_AFTER_MS` after it settled, and heard in exactly one digest.
 *
 *   npx tsx scripts/test-cut-question.ts
 */
type Inspect = Extract<ProviderLiveDriver["resume"], { kind: "native" }>["inspect"]
type Evidence = Awaited<ReturnType<Inspect>>

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, done: () => boolean, timeoutMs: number): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !done(); await pause(20)) if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
}

/** The host that dies: an Apex starts one Fin, and the host is killed as the Fin's harness takes its brief. */
async function dyingHost(root: string): Promise<void> {
  const script: Script = async (turn) => {
    if (turn.text.includes("You're fin:")) return new Promise<string>(() => {})
    const started = await turn.world.agents.start(turn.caller, { brief: { objective: "Review the header." }, harness: "codex", name: "header", clientKey: "header", cwd: root })
    if ("refused" in started) throw new Error(started.why)
    writeFileSync(join(root, "fin"), started.conversation!)
    return "Started it."
  }
  const world = new AgentsWorld({
    root, script, transcripts: true,
    heard: (heard) => { if (heard.kind === "prompt" && heard.text.includes("You're fin:header")) process.kill(process.pid, "SIGKILL") },
  })
  const apex = await world.apex("codex")
  writeFileSync(join(root, "apex"), apex.conversation)
  world.say(apex.conversation, "Start the header review.")
  await new Promise(() => {})
}

if (process.argv[2] === "--host") await dyingHost(process.argv[3]!)

const AVAILABLE: Evidence = { kind: "available", checkpoint: "scripted-record", strategy: "same-session" }

/** The native check the next host runs before it continues the cut turn: answered as each ending says. */
class HeldCheck {
  calls = 0
  /** When the check that was held open settled, if it has. */
  settledAt: number | undefined
  private answer: { pass: (evidence: Evidence) => void; fail: (error: Error) => void } | undefined

  readonly inspect: Inspect = () => {
    this.calls += 1
    // The first can't finish yet (it ran out of time and found nothing against the session): tried again soon.
    if (this.calls === 1) return Promise.reject(new NativeVerificationPendingError("The native session's owner didn't answer in time.", true))
    if (this.settledAt !== undefined) return Promise.resolve(AVAILABLE)
    return new Promise<Evidence>((pass, fail) => {
      this.answer = { pass, fail }
    })
  }

  get holding(): boolean {
    return this.answer !== undefined && this.settledAt === undefined
  }

  pass(): void {
    this.settledAt = Date.now()
    this.answer!.pass(AVAILABLE)
  }

  refuse(): void {
    this.settledAt = Date.now()
    this.answer!.fail(new Error("The saved native session is gone."))
  }
}

const base = mkdtempSync(join(tmpdir(), "mako-cut-question-"))
try {
  for (const ending of ["continued", "asked", "verified", "unverified"] as const) {
    const root = join(base, ending)
    const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "--host", root], { stdio: "ignore" })
    const signal = await new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, killed) => resolve(killed)))
    assert.equal(signal, "SIGKILL", `${ending}: the first host was killed as the Fin took its brief`)
    const apex = readFileSync(join(root, "apex"), "utf8")
    const fin = readFileSync(join(root, "fin"), "utf8")

    const held = ending === "verified" || ending === "unverified"
    const check = new HeldCheck()
    const world = new AgentsWorld({
      root, transcripts: true, resumeInSlices: true,
      ...(held && { nativeInspection: check.inspect }),
      script: async (turn) => (turn.conversation === apex ? "Noted." : "Done with the header."),
    })
    // The Fin's continuation is refused while this host takes up what the last one left.
    let refusing = !held
    let refused = 0
    const continueTurn = world.live.continueTurn.bind(world.live)
    world.live.continueTurn = (id, input) => {
      if (id === fin && refusing) {
        refused += 1
        throw new Error("This conversation can't take a continuation yet")
      }
      return continueTurn(id, input)
    }
    try {
      await world.resumed
      const child = world.store.edges().all.find((edge) => edge.name === "header")!.child
      const reports = () => world.store.reportsOf(child, 0)
      const cutQuestions = () => reports().filter((report) => report.id.includes(":cut:"))
      const digests = () => world.prompts.filter((prompt) => prompt.conversation === apex && prompt.text.startsWith(FROM_AGENTS))
      const carrying = (id: string) => digests().filter((prompt) => prompt.text.split("<mako-reports>")[1]?.includes(`"report":${JSON.stringify(id)}`)).length
      const heardOnce = async () => {
        await world.settle()
        assert.equal(world.store.undeliveredReports().length, 0, `${ending}: every report was heard`)
        for (const report of reports()) assert.equal(carrying(report.id), 1, `${ending}: the report "${report.summary.slice(0, 40)}" reached its Apex once`)
      }
      if (held) {
        // The check can't finish, is tried again, and then runs on, well past the wait before anyone is asked.
        await until("the second check", () => check.holding, 15_000)
        const heldFrom = Date.now()
        await pause(STRANDED_AFTER_MS + 2_000)
        assert.ok(check.holding, `${ending}: the check is still held open`)
        assert.equal(cutQuestions().length, 0, `${ending}: nothing is asked while the continuation is still being verified`)
        if (ending === "verified") {
          check.pass()
          await until("the Fin to finish", () => reports().at(-1)?.status === "done", 20_000)
          await pause(STRANDED_AFTER_MS + 500)
          assert.equal(cutQuestions().length, 0, "no cut question was ever written for a turn Mako continued once verified")
          await heardOnce()
        } else {
          check.refuse()
          const settledAt = check.settledAt!
          await until("the cut question", () => cutQuestions().length === 1, STRANDED_AFTER_MS * 2 + 5_000)
          const question = cutQuestions()[0]!
          // The wait counts from when the check settled without a continuation, not from the cut.
          assert.ok(question.at >= settledAt + STRANDED_AFTER_MS - 50, `the question waited ${question.at - settledAt} ms after the check settled, not ${STRANDED_AFTER_MS}`)
          await until("its Apex hearing it", () => carrying(question.id) >= 1, 15_000)
          await pause(STRANDED_AFTER_MS + 500)
          assert.equal(cutQuestions().length, 1, "one question for the one cut")
          assert.equal(carrying(question.id), 1, "its Apex heard it in exactly one digest")
          await heardOnce()
          console.log(`  unverified: asked ${question.at - settledAt} ms after the check settled, ${question.at - heldFrom} ms after it was held open`)
        }
        continue
      }
      assert.ok(refused >= 1, `${ending}: the continuation was asked for as the host took the Fin up, and refused`)
      assert.equal(cutQuestions().length, 0, `${ending}: nothing is asked before the wait is over`)
      if (ending === "continued") {
        // By the time the cut is looked at, the continuation can be admitted: it is, and nobody is asked anything.
        refusing = false
        await until("the Fin to finish", () => reports().at(-1)?.status === "done", STRANDED_AFTER_MS + 20_000)
        assert.equal(cutQuestions().length, 0, "no cut question was ever written for a turn Mako continued")
        await heardOnce()
      } else {
        // It still can't be continued: its Apex is asked, once.
        await until("the cut question", () => cutQuestions().length === 1, STRANDED_AFTER_MS + 10_000)
        const question = cutQuestions()[0]!
        await until("its Apex hearing it", () => carrying(question.id) >= 1, 15_000)
        assert.equal(cutQuestions().length, 1, "one question for the one cut")
        await heardOnce()
        assert.equal(carrying(question.id), 1, "its Apex heard it in exactly one digest")
      }
    } finally {
      // A check still held open when an assertion failed would hold the close too.
      if (check.holding) check.refuse()
      await world.close()
    }
  }
  console.log("cut question: a cut Mako continues is never asked about, even while its native check runs past the wait; one it can't continue is asked about once, counted from when its continuation settled; every stored report reached its Apex exactly once")
} finally {
  rmSync(base, { recursive: true, force: true })
}
