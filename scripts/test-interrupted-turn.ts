import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import {
  checkoutAccount,
  closeCutOffCalls,
  pendingInterruption,
  recordCutOffCalls,
  TurnSteps,
} from "@mako/host/conversations/interrupted-turn"
import type { Entry } from "@mako/sessions/entries"

const root = mkdtempSync(join(tmpdir(), "mako-interrupted-turn-"))
const turn = (requestId: string, updates: LiveUpdate[], steps?: TurnSteps): Entry[] => {
  const all: LiveUpdate[] = [{ kind: "user", requestId, text: "go" }, ...updates]
  for (const update of updates) steps?.observe(update)
  return reduceLiveUpdates([], all)
}

try {
  // A chain of calls: each result was read before the next call started.
  // Parallel calls: the ones that returned after the last start were not.
  {
    const steps = new TurnSteps()
    const blocks = turn("r1", [
      { kind: "tool", id: "a", title: "Read a", status: "running" },
      { kind: "tool-update", id: "a", status: "completed", output: "a" },
      { kind: "tool", id: "b", title: "Research b", status: "running" },
      { kind: "tool", id: "c", title: "Research c", status: "running" },
      { kind: "tool-update", id: "b", status: "failed", output: "b broke" },
      { kind: "tool-update", id: "c", status: "failed", output: "closed", unfinished: true },
    ], steps)
    const record = recordCutOffCalls(blocks, "r1", steps, join(root, "r1"))
    assert.deepEqual(record.calls?.map((call) => [call.id, call.result]), [["b", "unseen"], ["c", "none"]])
    assert.match(readFileSync(record.calls![0]!.file!, "utf8"), /^# Research b\n\nStatus: failed\n\nb broke\n$/, "a failure the agent never read is its result too")
    assert.equal(record.calls![1]!.file, undefined)
  }

  // Thinking or a reply after a result means the agent read it.
  {
    const steps = new TurnSteps()
    const blocks = turn("r2", [
      { kind: "tool", id: "a", title: "Run tests", status: "running" },
      { kind: "tool-update", id: "a", status: "completed", output: "ok" },
      { kind: "thinking", text: "Tests pass." },
    ], steps)
    assert.deepEqual(recordCutOffCalls(blocks, "r2", steps, join(root, "r2")), { calls: [] })
  }

  // Only the request's own turn; its open rows are closed, earlier turns are not touched.
  {
    const blocks = reduceLiveUpdates([], [
      { kind: "user", requestId: "old", text: "before" },
      { kind: "tool", id: "old-open", title: "Old", status: "running" },
      { kind: "user", requestId: "r3", text: "now" },
      { kind: "tool", id: "open", title: "Build", status: "in_progress" },
      { kind: "tool-update", id: "open", output: "compiling 3 of 9" },
      { kind: "tool", id: "done", title: "Lint", status: "completed" },
    ])
    const closing = closeCutOffCalls(blocks, "r3")
    assert.deepEqual(closing, [{ kind: "tool-update", id: "open", status: "failed", unfinished: true }])
    const closed = reduceLiveUpdates(blocks, closing)
    const open = closed.find((block) => block.type === "tool" && block.id === "open")
    assert.ok(open?.type === "tool" && open.status === "failed" && open.unfinished && open.output === "compiling 3 of 9", "a closed call keeps what it had produced")
    assert.deepEqual(closeCutOffCalls(blocks, "r3", "canceled").map((update) => update.status), ["canceled"], "a stopped turn's calls close canceled")
    const record = recordCutOffCalls(closed, "r3", undefined, join(root, "r3"))
    assert.deepEqual(record.calls?.map((call) => call.id), ["open"], "without steps only the calls that never returned are known")
  }

  // At most twelve are listed; the rest are counted.
  {
    const updates: LiveUpdate[] = Array.from({ length: 15 }, (_, index) => ({
      kind: "tool" as const, id: `t${index}`, title: `Call ${index}`, status: "running",
    }))
    const record = recordCutOffCalls(turn("r4", updates), "r4", undefined, join(root, "r4"))
    assert.equal(record.calls?.length, 12)
    assert.equal(record.moreCalls, 3)
  }

  // The account: the latest settled turn only, told once, never for Stop,
  // never for a journal written before calls were recorded.
  {
    const at = new Date(2026, 8, 28, 22, 25, 35).getTime()
    const base = { attachments: [], text: "x" }
    const interrupted: LiveRequest = {
      ...base,
      id: "i",
      status: "interrupted",
      error: "Cursor's SDK process exited (code 70)",
      interruption: {
        reason: "provider-exited",
        at,
        calls: [
          { id: "a", title: "Research Capy", result: "none" },
          { id: "b", title: "Worktree setup in local reference repos", result: "unseen", file: "/tmp/b.md" },
        ],
        moreCalls: 2,
      },
    }
    const next: LiveRequest = { ...base, id: "n", status: "queued" }
    const told = pendingInterruption([interrupted, next], "n", at + 60_000)
    assert.equal(told?.requestId, "i")
    assert.equal(told?.account, [
      "Your previous turn was cut short at 22:25:35: Cursor's SDK process exited (code 70). Work you did before then is in place.",
      "These calls never returned a result. They may have done part of their work or none of it; check before you repeat them:",
      "- Research Capy",
      "These calls returned after your last step, so you have not seen their results:",
      "- Worktree setup in local reference repos: the full result is saved at /tmp/b.md",
      "2 more calls from that turn ended the same way.",
      "If a call from that turn is described as interrupted or cancelled by the user, that is wrong: the user did not stop it.",
    ].join("\n"))
    assert.match(pendingInterruption([interrupted, next], "n", at + 86_400_000)!.account, /cut short at Sep 28, 22:25:35/, "another day names the day")

    const toldAlready = { ...interrupted, interruption: { ...interrupted.interruption!, told: at } }
    assert.equal(pendingInterruption([toldAlready, next], "n"), undefined)
    const stopped = { ...interrupted, interruption: { ...interrupted.interruption!, reason: "stopped" as const } }
    assert.equal(pendingInterruption([stopped, next], "n"), undefined)
    const older = { ...interrupted, interruption: { reason: "provider-exited" as const, at } }
    assert.equal(pendingInterruption([older, next], "n"), undefined, "a journal from before this record says nothing")
    const later: LiveRequest = { ...base, id: "l", status: "completed" }
    assert.equal(pendingInterruption([interrupted, later, next], "n"), undefined, "a later turn already moved on")
    // A turn Mako stopped unsaved: the agent is told why in words it can use, not Mako's storage error, and that the person didn't stop it.
    const unsaved = { ...interrupted, error: "database or disk is full", interruption: { ...interrupted.interruption!, reason: "not-saved" as const } }
    const unsavedAccount = pendingInterruption([unsaved, next], "n", at + 60_000)!.account
    assert.match(unsavedAccount, /^Your previous turn was cut short at 22:25:35: Mako couldn't save the conversation, so it stopped you\. Work you did before then is in place\./)
    assert.match(unsavedAccount, /the user did not stop it/)
    const budget = { ...interrupted, error: undefined, interruption: { ...interrupted.interruption!, reason: "goal-budget" as const } }
    const budgetAccount = pendingInterruption([budget, next], "n", at + 60_000)!.account
    assert.match(budgetAccount, /^Your previous turn was cut short at 22:25:35: the goal reached its token budget, so Mako stopped you\./)
    assert.match(budgetAccount, /the user did not stop it/)
    const quit = { ...interrupted, interruption: { ...interrupted.interruption!, reason: "host-quit" as const } }
    assert.doesNotMatch(pendingInterruption([quit, next], "n")!.account, /did not stop it/, "quitting Mako was the user's doing")
  }
  // When the first call the agent has no account of started: what moved in the checkout counts from there.
  {
    const steps = new TurnSteps()
    const blocks = turn("r5", [
      { kind: "tool", id: "read", title: "Read AGENTS.md", status: "running", at: 1_000 },
      { kind: "tool-update", id: "read", status: "completed", output: "# Agents" },
      { kind: "thinking", text: "Commit and push." },
      { kind: "tool", id: "push", title: "git commit && git push", status: "running", at: 2_000 },
      { kind: "tool", id: "check", title: "gh pr view", status: "running", at: 3_000 },
    ], steps)
    const record = recordCutOffCalls(blocks, "r5", steps, join(root, "r5"))
    assert.deepEqual(record.calls?.map((call) => call.id), ["push", "check"])
    assert.equal(record.since, 2_000, "from the first call the agent has no account of, not the turn's start")
    const interrupted: LiveRequest = { id: "i5", attachments: [], text: "x", status: "interrupted", interruption: { reason: "connection-lost", at: 4_000, ...record } }
    assert.equal(pendingInterruption([interrupted, { id: "n5", attachments: [], text: "y", status: "queued" }], "n5")?.since, 2_000, "the account carries it to the prompt that tells it")
    assert.equal(checkoutAccount([]), "Nothing moved in the checkout since the first of those calls started: no commit, push or file change.")
    assert.equal(
      checkoutAccount([{ name: "mako", head: { from: "aaaaaaaa11", to: "bbbbbbbb22", moves: ["commit: Ship it"] }, commits: [{ sha: "bbbbbbbb22", subject: "Ship it" }], remotes: [{ ref: "origin/mako/fin", from: "aaaaaaaa11", to: "bbbbbbbb22", how: "update by push" }], files: ["mako/AGENTS.md"], moreFiles: 0 }]),
      "In the checkout since the first of those calls started:\n- mako: HEAD moved aaaaaaaa → bbbbbbbb (commit: Ship it). New commit: bbbbbbbb Ship it. origin/mako/fin moved aaaaaaaa → bbbbbbbb (update by push). Files changed: mako/AGENTS.md.",
    )
  }
  console.log("interrupted turn: steps, closed rows, saved results, the one-time account and the checkout since its first call ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
