import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import type { ReceivedRecords } from "@mako/sessions/record-sync"
import { arriveMove, readyForMove, type ArrivingSession, type MoveArrivalDeps } from "@mako/host/conversations/move-arrival"

/**
 * A Thread arriving on a cloud machine opens each Session there before it answers, so the device asks the cloud to
 * claim only a move whose harnesses started: one that can't start fails the arrival, naming the harness and, when the
 * account gave the machine no sign-in for it, the setting that does. Records are written before anything opens.
 */

const root = mkdtempSync(join(tmpdir(), "mako-move-arrival-"))
const git = new Git()
try {
  const folder = join(root, "work")
  await git.output(root, ["init", "-q", folder])
  const gitDir = join(folder, ".git")
  const checkpoint = { version: 1 as const, sha256: "a".repeat(64), bytes: 1, head: "b".repeat(40), index: "c".repeat(40), work: "d".repeat(40) }
  const arriving = (failing: Record<string, string>, signedIn: Record<string, boolean | undefined>) => {
    const order: string[] = []
    const opened: ArrivingSession[] = []
    const deps: MoveArrivalDeps = {
      git,
      records: () => ({ id: "https://gateway.test/v1/threads/t-1", base: "https://gateway.test/v1/threads/t-1/records", authorization: "Bearer test" }),
      workspace: () => folder,
      workspaceProblem: () => undefined,
      workspaceSettled: async () => ({ path: folder }),
      warm: async () => {},
      receive: async (_link, sessions) => {
        order.push("receive")
        return sessions.map((session): ReceivedRecords => ({
          harness: session.harness, nativeId: session.nativeId,
          pulled: { versions: 1, held: 0, chunks: 1, bytes: 1, requests: 1, ms: 1 },
          restored: { kind: "restored", path: `/home/node/${session.harness}/${session.nativeId}`, files: 1, rows: 0, ms: 1 },
        }))
      },
      installed: () => null,
      open: async (session) => {
        order.push(`open ${session.harness}`)
        opened.push(session)
        const failure = failing[session.harness]
        if (failure) throw new Error(failure)
      },
      signedIn: (harness) => signedIn[harness],
      label: (harness) => ({ codex: "Codex", cursor: "Cursor", devin: "Devin" })[harness] ?? harness,
      scratch: join(root, "scratch"),
    }
    return { deps, order, opened }
  }
  const input = (move: string) => ({
    move, folder, checkpoint,
    sessions: [
      { harness: "codex", nativeId: "n-1", open: { conversationId: randomUUID(), modeId: "access:full", tuning: { model: "gpt-5.5" } } },
      { harness: "cursor", nativeId: "n-2", open: { conversationId: randomUUID() } },
    ],
  })
  // The checkout already arrived for these moves, so only the sessions are at stake.
  const arrivedMove = (move: string) => writeFileSync(join(gitDir, `mako-move-${move}.json`), JSON.stringify({ move, sha256: checkpoint.sha256, at: Date.now() }))

  // Every harness starts: written first, then each opened as it ran on the device, one at a time.
  {
    const move = randomUUID()
    arrivedMove(move)
    const { deps, order, opened } = arriving({}, {})
    const asked = input(move)
    const arrival = await arriveMove(deps, asked)
    assert.deepEqual(order, ["receive", "open codex", "open cursor"])
    assert.deepEqual(opened[0], { harness: "codex", nativeId: "n-1", folder, ...asked.sessions[0]!.open })
    assert.equal(arrival.checkout, "arrived")
    assert.ok(arrival.sessions.every((session) => session.opened && session.opened.ms >= 0), "each says how long its start took")
  }

  // One can't start: the arrival fails, naming it; with no sign-in given for it, naming the setting too.
  {
    const move = randomUUID()
    arrivedMove(move)
    const { deps } = arriving({ cursor: "API key is required for cloud operations." }, { codex: true, cursor: false })
    await assert.rejects(arriveMove(deps, input(move)), (error: Error) => {
      assert.equal(error.message, `Cursor couldn't start in the cloud: API key is required for cloud operations. Mako Cloud has no sign-in for Cursor: turn on "Use this Mac's sign-ins" in Settings › Account, then move the Thread again.`)
      return true
    })
    // Signed in, or before the machine was given any set, the harness's own words stand alone.
    for (const given of [true, undefined]) {
      const again = arriving({ cursor: "Cursor's service refused the session." }, { cursor: given })
      await assert.rejects(arriveMove(again.deps, input(move)), { message: "Cursor couldn't start in the cloud: Cursor's service refused the session." })
    }
  }

  // A device that doesn't ask for its sessions to be opened gets the arrival as before: written, nothing started.
  {
    const move = randomUUID()
    arrivedMove(move)
    const { deps, order } = arriving({}, {})
    const asked = input(move)
    await arriveMove(deps, { ...asked, sessions: asked.sessions.map(({ harness, nativeId }) => ({ harness, nativeId })) })
    assert.deepEqual(order, ["receive"])
  }
  // Before the device releases it: answered once the folder is cloned and each harness's settings read ahead (a
  // harness that can't read them is left to its open), refused with why when the folder couldn't be made.
  const warmed: string[] = []
  assert.deepEqual(await readyForMove({ workspaceSettled: async () => ({ path: folder }), warm: async (harness) => void warmed.push(harness) }, { folder, harnesses: ["codex", "cursor", "codex"] }), { folder })
  assert.deepEqual(warmed, ["codex", "cursor"], "each harness once")
  assert.deepEqual(await readyForMove({ workspaceSettled: async () => ({ path: folder }), warm: async () => { throw new Error("API key is required") } }, { folder, harnesses: ["cursor"] }), { folder }, "not judged ahead")
  await assert.rejects(readyForMove({ workspaceSettled: async () => ({ problem: "the repository isn't reachable from the cloud" }), warm: async () => {} }, { folder }), { message: "The cloud machine couldn't make this Thread's folder: the repository isn't reachable from the cloud" })
  await assert.rejects(readyForMove({ workspaceSettled: async () => ({ path: "/Users/someone/else" }), warm: async () => {} }, { folder }), /not the move's/)
  console.log("PASS: a machine is ready for a move once its folder is cloned; an arriving Thread's sessions are written, then opened one at a time before the machine answers; one that can't start fails the arrival by name, with the sign-in setting when the cloud has none for it")
} finally {
  git.close()
  rmSync(root, { recursive: true, force: true })
}
