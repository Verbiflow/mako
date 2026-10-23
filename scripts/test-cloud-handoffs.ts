import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import type { MoveCheckpoint } from "@mako/protocol/moves"
import type { ThreadHandOff, ThreadMoveOutcome } from "@mako/host/contracts/cloud-threads"
import type { SessionExecution } from "@mako/host/contracts/thread-execution"
import { SessionIdSchema, ThreadIdSchema, type SessionId, type ThreadPlacement } from "@mako/host/contracts/thread-identity"
import { CloudHandOffs, workingThreads, type WorkingSnapshot, type WorkingThread } from "@mako/host/conversations/cloud-handoffs"
import { CloudReadiness, type ReadinessAccount } from "@mako/host/conversations/cloud-readiness"
import type { CloudRepository } from "@mako/host/contracts/cloud-threads"
import type { LivePermissionRequest, LiveSessionState } from "@mako/host/contracts/providers-acp"
import { SleepHandOff } from "@mako/host/conversations/sleep-handoff"

/**
 * Handing agents at work to the cloud, all at once (`CloudHandOffs`), as this Mac sleeps (`SleepHandOff`, against a
 * stand-in for the native helper), and keeping Threads at work ready to move (`CloudReadiness`, against a real
 * checkout): which Threads are at work, one move per Thread named by the handoff, the sleep held until the handoff
 * answers or its deadline, and only what changed sent ahead, to a cloud Thread a move then takes once.
 */
const root = mkdtempSync(join(tmpdir(), "mako-handoffs-"))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()

/** A conversation as `workingThreads` reads it: its summary and snapshot, and where the Thread store places it. */
function conversation(id: string, thread: string, how: { status?: LiveSessionState["status"]; permissions?: number; background?: number; state?: SessionExecution["state"] } = {}) {
  const snapshot: WorkingSnapshot = {
    session: { harness: "codex", status: how.status ?? "ready", title: `Thread ${thread}`, ...how.background && { backgroundTasks: how.background } },
    permissions: Array.from({ length: how.permissions ?? 0 }, (_, index): LivePermissionRequest => ({ id: `p-${index}`, sessionId: id, title: "Run a command", options: [] })),
    requests: [],
  }
  return {
    summary: { session: { id } },
    snapshot,
    placement: { thread: ThreadIdSchema.parse(thread), session: SessionIdSchema.parse(randomUUID()) } satisfies ThreadPlacement,
    state: how.state ?? "here",
  }
}

try {
  // Which Threads are at work here: a turn running, an approval waiting or background work, one conversation each, a
  // running one first; never one already in the cloud, or owned elsewhere, or idle.
  {
    const threadA = randomUUID()
    const threadB = randomUUID()
    const threadC = randomUUID()
    const all = [
      conversation(randomUUID(), threadA, { status: "ready", permissions: 1 }),
      conversation(randomUUID(), threadA, { status: "running" }),
      conversation(randomUUID(), threadB, { background: 2 }),
      conversation(randomUUID(), threadC),
      conversation(randomUUID(), randomUUID(), { status: "running", state: "elsewhere" }),
    ]
    const inCloud = conversation(randomUUID(), randomUUID(), { status: "running" })
    const byId = new Map([...all, inCloud].map((each) => [each.summary.session.id, each]))
    const working = workingThreads({
      live: { summaries: () => [...byId.values()].map((each) => each.summary), snapshot: (id) => byId.get(id)?.snapshot ?? null },
      threads: {
        journalPlacement: (id) => byId.get(id)?.placement,
        execution: (session: SessionId) => {
          const found = [...byId.values()].find((each) => each.placement.session === session)
          return found ? { state: found.state } : undefined
        },
      },
      cloud: (id) => id === inCloud.summary.session.id,
    })
    assert.deepEqual(working.map((each) => each.thread).sort(), [threadA, threadB].sort(), "Threads at work, each once")
    assert.equal(working.find((each) => each.thread === threadA)?.conversationId, all[1]?.summary.session.id, "the running conversation is the one asked from")
  }

  // A handoff: one move per Thread, named by the handoff and the Thread (asked again, the same moves); a Thread that
  // can't go says why before anything moves; signed out, nothing goes.
  {
    const working: WorkingThread[] = [{ conversationId: "c-1", thread: "t-1", harness: "codex" }, { conversationId: "c-2", thread: "t-2", harness: "claude" }]
    const moves: Array<[string, string, ThreadHandOff | undefined, { answer?: "released" } | undefined]> = []
    const leaving = new Set<string>()
    const settledBy: number[] = []
    let unavailable: string | undefined
    const changed: unknown[] = []
    const handOffs = new CloudHandOffs({
      file: join(root, "handoff.json"),
      working: () => working,
      moves: {
        move: async (conversationId, move, handOff, options): Promise<ThreadMoveOutcome> => {
          moves.push([conversationId, move, handOff, options])
          if (conversationId === "c-2") return { kind: "kept-here", reason: "It works in the project folder." }
          return options?.answer === "released" ? { kind: "released", cloudThread: "t-cloud" } : { kind: "moved", cloudThread: "t-cloud" }
        },
        refusal: async (conversationId) => (conversationId === "c-2" ? "It works in the project folder." : undefined),
        leaving: (thread) => leaving.has(thread),
        settled: async (deadline) => (settledBy.push(deadline), 0),
      },
      unavailable: async () => unavailable,
      changed: (settings) => void changed.push(settings),
    })
    assert.deepEqual((await handOffs.candidates()).map((each) => [each.conversationId, each.refusal]), [["c-1", undefined], ["c-2", "It works in the project folder."]])
    const handOff = randomUUID()
    const results = await handOffs.handOff(handOff, "quit")
    assert.deepEqual(results.map((each) => [each.conversationId, each.outcome.kind]), [["c-1", "released"], ["c-2", "kept-here"]], "a quit hears each Thread once this Mac let go of it")
    assert.deepEqual(moves.map(([, , how, options]) => [how, options]), [[{ why: "quit" }, { answer: "released" }], [{ why: "quit" }, { answer: "released" }]])
    await handOffs.handOff(handOff, "quit")
    assert.equal(moves[2]?.[1], moves[0]?.[1], "asked again, the same move for the same Thread")
    assert.notEqual(moves[0]?.[1], moves[1]?.[1], "each Thread its own move")
    await handOffs.handOff(randomUUID(), "sleep", 12345)
    assert.deepEqual(moves.at(-1)?.[2], { why: "sleep", releaseBy: 12345 }, "a sleeping Mac's deadline goes with each move")
    assert.deepEqual(moves.at(-1)?.[3], {}, "a sleep waits for each Thread to start in the cloud")
    assert.deepEqual(settledBy, [12345], "and for every move already running here, until its deadline")
    // A Thread a quit's move still carries isn't moved again as the Mac sleeps: the sleep waits for that move instead.
    leaving.add("t-1")
    const counted = moves.length
    await handOffs.handOff(randomUUID(), "sleep", 23456)
    assert.deepEqual(moves.slice(counted).map(([conversationId]) => conversationId), ["c-2"], "the moving Thread isn't moved twice")
    assert.deepEqual(settledBy, [12345, 23456])
    leaving.clear()
    unavailable = "Sign in to Mako Cloud to hand agents to the cloud."
    const before = moves.length
    assert.deepEqual((await handOffs.handOff(randomUUID(), "quit")).map((each) => each.outcome), [{ kind: "kept-here", reason: unavailable }, { kind: "kept-here", reason: unavailable }])
    assert.equal(moves.length, before, "signed out, nothing moves")
    assert.equal((await handOffs.candidates())[0]?.refusal, unavailable)
    // The person's choice for sleep: on by default, kept across a restart.
    unavailable = undefined
    assert.deepEqual(await handOffs.settings(), { onSleep: true })
    await handOffs.setOnSleep(false)
    assert.deepEqual(changed, [{ onSleep: false }], "windows hear the change")
    const again = new CloudHandOffs({ file: join(root, "handoff.json"), working: () => [], moves: { move: async () => ({ kind: "moved", cloudThread: "" }), refusal: async () => undefined, leaving: () => false, settled: async () => 0 }, unavailable: async () => undefined, changed: () => {} })
    assert.equal(await again.onSleep(), false, "kept across a restart")
  }

  // The sleep watch, against a stand-in for the native helper: told the Mac will sleep, it hands off with a deadline
  // inside the hold, and lets the Mac sleep once the handoff answers; a handoff that doesn't answer in time is let go.
  {
    const helper = join(root, "fake-helper.mjs")
    writeFileSync(helper, `
      import { createInterface } from "node:readline"
      console.log("ready")
      const lines = createInterface({ input: process.stdin })
      let id = 0
      const sleep = () => { id += 1; console.log("will-sleep " + id) }
      lines.on("line", (line) => {
        if (line.startsWith("allow ")) { console.log("slept " + line.slice(6) + " answer"); if (id < 2) sleep(); else process.exit(0) }
      })
      sleep()
    `)
    const handOffs: Array<{ at: number; releaseBy: number }> = []
    const allowedAfter: number[] = []
    let calls = 0
    const hold = 5_000
    const done = new Promise<void>((resolve) => {
      const watch = new SleepHandOff({
        helper: async () => helper,
        enabled: async () => true,
        handOff: async (_handOff, releaseBy) => {
          calls += 1
          const at = Date.now()
          handOffs.push({ at, releaseBy })
          // The first handoff answers at once; the second never does, and the hold lets the Mac sleep anyway.
          if (calls === 1) return
          await new Promise(() => {})
        },
        woke: () => {},
        holdMs: hold,
        spawn: (path, args) => {
          const child = spawn(process.execPath, [path, ...args], { stdio: ["pipe", "pipe", "pipe"] })
          child.stdout.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString("utf8").split("\n")) if (line.startsWith("slept ")) allowedAfter.push(Date.now())
          })
          child.once("exit", () => resolve())
          return child
        },
      })
      void watch.refresh()
    })
    await done
    assert.equal(handOffs.length, 2)
    for (const each of handOffs) assert.ok(each.releaseBy > each.at && each.releaseBy <= each.at + hold, `a deadline inside the hold: ${each.releaseBy - each.at} ms`)
    assert.ok((allowedAfter[0] ?? 0) - (handOffs[0]?.at ?? 0) < 500, "answered as soon as the handoff did")
    const waited = (allowedAfter[1] ?? 0) - (handOffs[1]?.at ?? 0)
    assert.ok(waited >= hold - 2_000 && waited < hold, `a hung handoff is let go before the hold ends: ${waited} ms`)
  }

  // Readiness, against a real checkout: a cloud Thread stands by, made once; the checkout goes when it changes, never
  // twice the same; records go each round; a move takes it once, and the Thread rests before standing by again.
  {
    const folder = join(root, "ready", "Users", "ada", "worktrees", "fix")
    sh(root, "init", "--quiet", folder)
    writeFileSync(join(folder, "a.txt"), "one\n")
    sh(folder, "add", ".")
    sh(folder, "commit", "--quiet", "-m", "base")
    const made: Array<{ threadId: string; standby?: boolean }> = []
    const checkpoints: string[] = []
    const records: string[][] = []
    /** Cloud Threads the cloud ended unused, as it says when one is made again. */
    const ended = new Set<string>()
    const account: ReadinessAccount = {
      createThread: async (threadId: string, _repository: CloudRepository, making?: { standby?: boolean }) => {
        made.push({ threadId, ...making?.standby && { standby: true } })
        return ended.has(threadId) ? { ready: false, ended: true as const } : { ready: false }
      },
      sendCheckpoint: async (_threadId: string, checkpoint: MoveCheckpoint) => {
        checkpoints.push(checkpoint.sha256)
        return { sent: true }
      },
      threadRecords: async (threadId: string) => ({ id: threadId, base: `https://gateway.test/v1/threads/${threadId}/records`, authorization: "Bearer t" }),
    }
    let enabled = true
    const repository = { url: "https://github.com/octocat/Hello-World" }
    const moving = new Set<string>()
    const readiness = new CloudReadiness({
      file: join(root, "ready.json"),
      git,
      scratch: join(root, "ready-scratch"),
      account: () => account,
      enabled: async () => enabled,
      working: () => [{ conversationId: "c-1", thread: "local-1", harness: "codex" }],
      leaving: (thread) => moving.has(thread),
      plan: async () => ({ thread: "local-1", folder, repository, paths: ["/codex/n-1.jsonl"], harness: "codex" }),
      sendRecords: async (_link, paths) => {
        records.push(paths)
        return [{ harness: "codex", nativeId: "n-1", versions: 1, held: 0, chunks: 1, bytes: 10, requests: 1, ms: 1, holdings: {} }]
      },
      newCloudThread: () => `t-${randomUUID().slice(0, 8)}`,
    })
    // A Thread on its way to the cloud isn't kept ready meanwhile: its move makes or takes the cloud Thread.
    moving.add("local-1")
    await readiness.refresh()
    assert.equal(made.length, 0, "nothing stands by for a Thread whose move runs")
    moving.delete("local-1")
    await readiness.refresh()
    await readiness.refresh()
    assert.equal(new Set(made.map((each) => each.threadId)).size, 1, "one cloud Thread stands by")
    assert.ok(made.every((each) => each.standby), "standing by: no machine until a move")
    assert.equal(checkpoints.length, 1, "the checkout goes once while it's unchanged")
    assert.equal(records.length, 2, "records each round, only what's new")
    writeFileSync(join(folder, "a.txt"), "one, changed\n")
    await readiness.refresh()
    assert.equal(checkpoints.length, 2, "changed, it goes again")
    assert.equal(await readiness.take("local-1", folder, { url: "https://github.com/someone/else" }), undefined, "another repository's move doesn't take it")
    // The cloud ended it unused (nobody kept it ready for a while): the next round stands by with a new one.
    const first = made.at(-1)!.threadId
    ended.add(first)
    await readiness.refresh()
    const replaced = made.at(-1)!.threadId
    assert.notEqual(replaced, first, "a new cloud Thread stands by in the ended one's place")
    assert.equal(JSON.parse(readFileSync(join(root, "ready.json"), "utf8")).threads["local-1"].cloudThread, replaced)
    writeFileSync(join(folder, "a.txt"), "one, changed again\n")
    await readiness.refresh()
    const standing = made.at(-1)?.threadId
    // One not kept ready lately (the Mac slept) may have ended in the cloud: a move doesn't take it.
    const kept = JSON.parse(readFileSync(join(root, "ready.json"), "utf8"))
    const stale = new CloudReadiness({ file: join(root, "stale.json"), git, scratch: join(root, "stale-scratch"), account: () => account, enabled: async () => true, working: () => [], leaving: () => false, plan: async () => ({ thread: "local-1", folder, repository, paths: [], harness: "codex" }), sendRecords: async () => [], newCloudThread: () => "t-stale" })
    writeFileSync(join(root, "stale.json"), JSON.stringify({ version: 1, threads: { "local-1": { ...kept.threads["local-1"], at: Date.now() - 25 * 60_000 } } }))
    assert.equal(await stale.take("local-1", folder, repository), undefined, "not taken: the move makes its own")
    assert.equal(JSON.parse(readFileSync(join(root, "stale.json"), "utf8")).threads["local-1"], undefined, "and forgotten here")
    assert.equal(await readiness.take("local-1", folder, repository), standing, "the move takes the cloud Thread standing by")
    assert.equal(await readiness.take("local-1", folder, repository), undefined, "once")
    const before = made.length
    await readiness.refresh()
    assert.equal(made.length, before, "taken, it rests: nothing stands by for it again yet")
    assert.ok(JSON.parse(readFileSync(join(root, "ready.json"), "utf8")).threads["local-1"] === undefined)
    enabled = false
    const quiet = new CloudReadiness({ file: join(root, "quiet.json"), git, scratch: join(root, "quiet-scratch"), account: () => account, enabled: async () => enabled, working: () => [{ conversationId: "c-9", thread: "local-9", harness: "codex" }], leaving: () => false, plan: async () => ({ thread: "local-9", folder, repository, paths: [], harness: "codex" }), sendRecords: async () => [], newCloudThread: () => "t-quiet" })
    await quiet.refresh()
    assert.ok(!made.some((each) => each.threadId === "t-quiet"), "with handing off on sleep off, nothing of a Thread goes to the cloud")
  }
  console.log("PASS: agents at work are handed off one move per Thread, named by the handoff; the sleep is held until the handoff answers or its deadline; Threads at work stand by in the cloud with only what changed, taken once by their move")
} finally {
  git.close()
  rmSync(root, { recursive: true, force: true })
}
