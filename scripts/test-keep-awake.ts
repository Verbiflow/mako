import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import type { KeepAwakeState } from "@mako/host/contracts/keep-awake"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { workingThreads, type WorkingSnapshot } from "@mako/host/conversations/cloud-handoffs"
import { KeepAwake, assertionName, keepAwakeHold, mayChangeWork } from "@mako/host/conversations/keep-awake"

/**
 * Keeping this Mac awake while its agents work (`KeepAwake`), against a stand-in for the native helper: what to hold
 * for each choice, count and power source, and the helper told to hold and to let go exactly as work starts and ends.
 * A hold is shown only once the helper says it holds. The real assertion is `pmset -g assertions`'s to prove.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

/** The helper as `KeepAwake` sees it: what it was told, and what it says. */
function standIn() {
  const child = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const told: string[] = []
  let ended = false
  stdin.on("data", (chunk: Buffer) => told.push(...chunk.toString("utf8").trim().split("\n")))
  stdin.on("end", () => {
    ended = true
  })
  return {
    process: Object.assign(child, { stdin, stdout, stderr }),
    told,
    ended: () => ended,
    say: (line: string) => void stdout.write(`${line}\n`),
    exit: (code: number) => void child.emit("exit", code),
    fail: (message: string) => void child.emit("error", new Error(message)),
  }
}

const root = mkdtempSync(join(tmpdir(), "mako-keep-awake-"))

function harness(options: { agents?: number; helper?: string | null; power?: string; file?: string; fails?: number; lingerMs?: number } = {}) {
  const spawned: ReturnType<typeof standIn>[] = []
  const shown: KeepAwakeState[] = []
  const work = { agents: options.agents ?? 0 }
  const awake = new KeepAwake({
    file: options.file ?? join(root, `${randomUUID()}.json`),
    helper: async () => (options.helper === null ? undefined : (options.helper ?? "/helper")),
    working: () => work.agents,
    changed: (state) => shown.push(state),
    coalesceMs: 1,
    lingerMs: options.lingerMs ?? 60_000,
    spawn: (path, args) => {
      assert.equal(path, options.helper ?? "/helper")
      assert.deepEqual(args, ["--keep-awake"])
      const helper = standIn()
      spawned.push(helper)
      // The real helper says it's up and where the power comes from before it reads anything.
      setImmediate(() => {
        helper.say("ready")
        helper.say(options.power ?? "power ac")
      })
      return helper.process
    },
  })
  /** The newest helper says `holding`, once it was told to. */
  const holds = async (kind: "idle" | "lid") => {
    spawned.at(-1)?.say(`holding ${kind}`)
    await settle()
  }
  return { awake, spawned, shown, work, holds, newest: () => spawned.at(-1) }
}

try {
  // What to hold: nothing unless agents work and it's on; a closed lid only by choice and only on power; never below
  // the floor; and a charge that can't be read holds rather than guess it's low.
  const on = { on: true, lidClosed: false }
  const lid = { on: true, lidClosed: true }
  const ac = { kind: "ac" } as const
  assert.deepEqual(keepAwakeHold(on, 0, ac), { kind: "rest" })
  assert.deepEqual(keepAwakeHold({ on: false, lidClosed: true }, 3, ac), { kind: "rest" })
  assert.deepEqual(keepAwakeHold(on, 3, ac), { kind: "idle", agents: 3 })
  assert.deepEqual(keepAwakeHold(lid, 3, ac), { kind: "lid", agents: 3 })
  assert.deepEqual(keepAwakeHold(lid, 3, { kind: "battery", percent: 80 }), { kind: "idle", agents: 3 })
  assert.deepEqual(keepAwakeHold(lid, 3, undefined), { kind: "idle", agents: 3 })
  assert.deepEqual(keepAwakeHold(on, 3, { kind: "battery", percent: 20 }), { kind: "idle", agents: 3 })
  assert.deepEqual(keepAwakeHold(lid, 3, { kind: "battery", percent: 19 }), { kind: "low-battery", agents: 3, percent: 19, floor: 20 })
  assert.deepEqual(keepAwakeHold(on, 3, { kind: "battery", percent: -1 }), { kind: "idle", agents: 3 })
  assert.equal(assertionName(1), "Mako: 1 agent working")
  assert.equal(assertionName(3), "Mako: 3 agents working")

  // Only batches that can change who works are counted: streamed text isn't.
  assert.equal(mayChangeWork({ sessionChanges: { status: "ready" } }), true)
  assert.equal(mayChangeWork({ sessionChanges: { backgroundTasks: 1 } }), true)
  assert.equal(mayChangeWork({ sessionCleared: ["backgroundTasks"] }), true)
  assert.equal(mayChangeWork({ requestChanges: [] }), true)
  assert.equal(mayChangeWork({ sessionChanges: { title: "New name" } }), false)
  assert.equal(mayChangeWork({}), false)

  // A wait on the person isn't work that holds a Mac awake; background work is. A handoff still takes both.
  const snapshots = new Map<string, WorkingSnapshot>([
    ["asking", { session: { harness: "codex", status: "ready" }, permissions: [{ id: "p", sessionId: "asking", title: "Run a command", options: [] }], requests: [] }],
    ["background", { session: { harness: "codex", status: "ready", backgroundTasks: 1 }, permissions: [], requests: [] }],
  ])
  const sources = {
    live: { summaries: () => [...snapshots.keys()].map((id) => ({ session: { id } })), loaded: () => true, snapshot: (id: string) => snapshots.get(id) ?? null },
    threads: { journalPlacement: () => ({ thread: ThreadIdSchema.parse(randomUUID()), session: SessionIdSchema.parse(randomUUID()) }), execution: () => ({ state: "here" as const }) },
    cloud: () => false,
  }
  assert.deepEqual(workingThreads(sources).map((thread) => thread.conversationId), ["asking", "background"])
  assert.deepEqual(workingThreads({ ...sources, asking: false }).map((thread) => thread.conversationId), ["background"])

  {
    // Nothing works: no helper runs at all.
    const { awake, spawned, shown } = harness()
    await awake.refresh()
    assert.equal(spawned.length, 0)
    assert.equal(shown.length, 0)
    assert.deepEqual(await awake.state(), { settings: { on: true, lidClosed: false }, hold: { kind: "rest" } })
    awake.stop()
  }

  {
    // Held exactly while work runs, and shown only once the helper says it holds.
    const { awake, spawned, shown, work, holds, newest } = harness({ agents: 1 })
    await awake.refresh()
    await settle()
    assert.deepEqual(newest()?.told, ["hold idle Mako: 1 agent working"])
    assert.deepEqual((await awake.state()).hold, { kind: "rest" }, "told isn't held")
    await holds("idle")
    assert.deepEqual((await awake.state()).hold, { kind: "idle", agents: 1 })
    assert.deepEqual(shown.at(-1)?.hold, { kind: "idle", agents: 1 })

    // A recount with nothing changed tells the helper nothing; a new count renames the hold.
    await awake.refresh()
    assert.equal(newest()?.told.length, 1)
    work.agents = 3
    awake.changed()
    await settle()
    await settle()
    assert.equal(newest()?.told.at(-1), "hold idle Mako: 3 agents working")
    await holds("idle")
    assert.deepEqual((await awake.state()).hold, { kind: "idle", agents: 3 })

    // Released the moment nothing works, and said at once; the helper stays a while for the next turn.
    work.agents = 0
    await awake.refresh()
    assert.equal(newest()?.told.at(-1), "release")
    assert.deepEqual(shown.at(-1)?.hold, { kind: "rest" })
    assert.equal(newest()?.ended(), false)
    work.agents = 2
    await awake.refresh()
    assert.equal(spawned.length, 1, "the same helper")
    assert.equal(newest()?.told.at(-1), "hold idle Mako: 2 agents working")

    // Stopping ends the helper, and what it held goes with it.
    awake.stop()
    await settle()
    assert.equal(newest()?.ended(), true)
  }

  {
    // The helper goes once the linger is over, so an idle Mako runs nothing.
    const { awake, work, newest, spawned } = harness({ agents: 1, lingerMs: 1 })
    await awake.refresh()
    await settle()
    work.agents = 0
    await awake.refresh()
    await settle()
    await settle()
    assert.equal(newest()?.ended(), true)
    work.agents = 1
    await awake.refresh()
    assert.equal(spawned.length, 2)
    awake.stop()
  }

  {
    // The choice: off lets go, the lid is held only by choice, and both are kept across a restart.
    const file = join(root, "kept.json")
    const { awake, newest, holds, shown } = harness({ agents: 2, file })
    await awake.refresh()
    await settle()
    await holds("idle")
    const off = await awake.set({ on: false })
    assert.deepEqual(off.hold, { kind: "rest" })
    assert.equal(newest()?.told.at(-1), "release")
    await awake.set({ on: true, lidClosed: true })
    await settle()
    assert.equal(newest()?.told.at(-1), "hold lid Mako: 2 agents working")
    await holds("lid")
    assert.deepEqual(shown.at(-1)?.hold, { kind: "lid", agents: 2 })
    awake.stop()
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, on: true, lidClosed: true })
    const again = harness({ file })
    assert.deepEqual((await again.awake.state()).settings, { on: true, lidClosed: true })
    again.awake.stop()

    // A file that doesn't parse leaves the defaults.
    writeFileSync(file, JSON.stringify({ version: 2 }))
    const unread = harness({ file })
    assert.deepEqual((await unread.awake.state()).settings, { on: true, lidClosed: false })
    unread.awake.stop()
  }

  {
    // On battery the lid isn't held; below the floor nothing is, and it's said; power back holds again.
    const file = join(root, "battery.json")
    writeFileSync(file, JSON.stringify({ version: 1, on: true, lidClosed: true }))
    const { awake, newest, holds } = harness({ agents: 1, file, power: "power battery 50" })
    await awake.refresh()
    await settle()
    assert.equal(newest()?.told.at(-1), "hold idle Mako: 1 agent working")
    await holds("idle")
    newest()?.say("power battery 19")
    await settle()
    assert.equal(newest()?.told.at(-1), "release")
    assert.deepEqual((await awake.state()).hold, { kind: "low-battery", agents: 1, percent: 19, floor: 20 })
    newest()?.say("power ac")
    await settle()
    assert.equal(newest()?.told.at(-1), "hold lid Mako: 1 agent working")
    await holds("lid")
    assert.deepEqual((await awake.state()).hold, { kind: "lid", agents: 1 })
    awake.stop()
  }

  {
    // macOS refuses: it never reads as held, and the next recount asks again.
    const { awake, newest, holds } = harness({ agents: 1 })
    await awake.refresh()
    await settle()
    newest()?.say("failed -536870212")
    await settle()
    assert.deepEqual((await awake.state()).hold, { kind: "failed", agents: 1 })
    await awake.refresh()
    assert.equal(newest()?.told.length, 2)
    await holds("idle")
    assert.deepEqual((await awake.state()).hold, { kind: "idle", agents: 1 })
    awake.stop()
  }

  {
    // No helper to be had: agents work and nothing's held, which is said, and it's looked for only once.
    let looked = 0
    const shown: KeepAwakeState[] = []
    const awake = new KeepAwake({
      file: join(root, "no-helper.json"),
      helper: async () => {
        looked += 1
        return undefined
      },
      working: () => 2,
      changed: (state) => shown.push(state),
    })
    await awake.refresh()
    await awake.refresh()
    assert.equal(looked, 1)
    await settle()
    assert.deepEqual(shown.at(-1)?.hold, { kind: "failed", agents: 2 })
    awake.stop()
  }

  {
    // The helper dies holding: that's said at once, and the next recount starts another, which holds again.
    const { awake, spawned, newest, holds } = harness({ agents: 1 })
    await awake.refresh()
    await settle()
    await holds("idle")
    newest()?.exit(1)
    assert.deepEqual((await awake.state()).hold, { kind: "failed", agents: 1 })
    await awake.refresh()
    await settle()
    assert.equal(spawned.length, 2)
    assert.equal(newest()?.told.at(-1), "hold idle Mako: 1 agent working")
    await holds("idle")
    assert.deepEqual((await awake.state()).hold, { kind: "idle", agents: 1 })
    awake.stop()
  }

  {
    // A helper that can't be spawned answers `error`, not `exit`: said, and the host goes on.
    const spawned: ReturnType<typeof standIn>[] = []
    const awake = new KeepAwake({
      file: join(root, "no-spawn.json"),
      helper: async () => "/helper",
      working: () => 1,
      changed: () => {},
      spawn: () => {
        const helper = standIn()
        spawned.push(helper)
        setImmediate(() => helper.fail("spawn EACCES"))
        return helper.process
      },
    })
    await awake.refresh()
    assert.deepEqual((await awake.state()).hold, { kind: "failed", agents: 1 })
    assert.equal(spawned.length, 1)
    awake.stop()
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("keep-awake: ok")
