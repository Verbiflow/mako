import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reduceLiveUpdates, type LiveBlock, type LiveUpdate } from "../electron/contracts/live-content.ts"
import type { LiveRequest } from "../electron/contracts/live-conversations.ts"
import {
  closeCutOffCalls,
  cutOffNote,
  pendingInterruption,
  recordCutOffCalls,
  TurnSteps,
} from "../electron/interrupted-turn.ts"

const root = mkdtempSync(join(tmpdir(), "mako-interrupted-turn-"))
const turn = (requestId: string, updates: LiveUpdate[], steps?: TurnSteps): LiveBlock[] => {
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
      { kind: "tool", id: "done", title: "Lint", status: "completed" },
    ])
    const note = cutOffNote({ reason: "provider-exited", at: 0 }, "Cursor's SDK process exited (code 70)")
    assert.equal(note, "This call was still running when the turn was cut short, so it never returned a result: Cursor's SDK process exited (code 70).")
    const closing = closeCutOffCalls(blocks, "r3", note)
    assert.deepEqual(closing, [{ kind: "tool-update", id: "open", status: "failed", output: note, unfinished: true }])
    const closed = reduceLiveUpdates(blocks, closing)
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
    const quit = { ...interrupted, interruption: { ...interrupted.interruption!, reason: "host-quit" as const } }
    assert.doesNotMatch(pendingInterruption([quit, next], "n")!.account, /did not stop it/, "quitting Mako was the user's doing")
  }
  console.log("interrupted turn: steps, closed rows, saved results, and the one-time account ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
