/**
 * The host's warm-up (`host-warmup.ts`): what a first launch loads into the host, loaded ahead. With fakes, it runs
 * its pieces one at a time and gives the loop back between them, waits out a start a person is waiting on, loads
 * nothing once the host is stopping, loads nothing for a harness that isn't installed or was never used here, and
 * never stands between a send and the piece it needs.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { HostWarmer, warmHost, warmPieces, type WarmPiece } from "@mako/host/harnesses/host-warmup"

/** A foreground a test holds and lets go. */
function foreground() {
  let held = false
  let waiters: (() => void)[] = []
  return {
    busy: () => held,
    idle: () => held ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve(),
    hold: () => { held = true },
    release: () => {
      held = false
      for (const resume of waiters.splice(0)) resume()
    },
    get waiting() { return waiters.length },
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const piece = (name: string, log: string[], work: () => Promise<void> = async () => {}): WarmPiece => ({ name, load: async () => { log.push(`${name} began`); await work(); log.push(`${name} ended`) } })

test("pieces load one at a time, the loop given back before each", async () => {
  const log: string[] = []
  const front = foreground()
  let pauses = 0
  const outcomes = await warmHost([piece("a", log, tick), piece("b", log)], { busy: front.busy, idle: front.idle, pause: async () => { pauses += 1; log.push("pause") } })
  assert.deepEqual(log, ["pause", "a began", "a ended", "pause", "b began", "b ended"])
  assert.equal(pauses, 2)
  assert.deepEqual(outcomes.map(({ name, state }) => `${name} ${state}`), ["a loaded", "b loaded"])
})

test("a start a person waits on holds the pieces after the one under way, until it's over", async () => {
  const log: string[] = []
  const front = foreground()
  const first = Promise.withResolvers<void>()
  const run = warmHost([piece("a", log, () => first.promise), piece("b", log)], { busy: front.busy, idle: front.idle })
  await tick()
  await tick()
  assert.deepEqual(log, ["a began"])
  front.hold()
  first.resolve()
  for (let turns = 0; turns < 5; turns += 1) await tick()
  assert.deepEqual(log, ["a began", "a ended"], "nothing more is loaded while the start is waited on")
  assert.equal(front.waiting, 1)
  front.release()
  await run
  assert.deepEqual(log, ["a began", "a ended", "b began", "b ended"])
})

test("a send never waits for the warm-up: it loads the piece itself, or joins the load under way", async () => {
  // A piece as a lazy package is: one load, shared by whoever asks.
  let loads = 0
  const loading = Promise.withResolvers<void>()
  let shared: Promise<void> | undefined
  const load = () => (shared ??= (async () => { loads += 1; await loading.promise })())
  const front = foreground()
  // The send comes first and holds the foreground, as a launch does: the warm-up hasn't touched the piece.
  front.hold()
  const run = warmHost([{ name: "package", load }], { busy: front.busy, idle: front.idle })
  for (let turns = 0; turns < 3; turns += 1) await tick()
  assert.equal(loads, 0, "the warm-up loads nothing while a start is waited on")
  const sends = load()
  assert.equal(loads, 1, "the send loads what it needs itself, at once")
  loading.resolve()
  await sends
  front.release()
  const outcomes = await run
  assert.equal(loads, 1, "and the warm-up, once free, finds it loaded")
  assert.equal(outcomes[0]?.state, "loaded")
})

test("a piece that fails is said and the rest go on; a stopping host loads nothing more", async () => {
  const log: string[] = []
  const front = foreground()
  let stopped = false
  const outcomes = await warmHost([
    { name: "broken", load: async () => { throw new Error("no such package") } },
    piece("b", log, async () => { stopped = true }),
    piece("c", log),
  ], { busy: front.busy, idle: front.idle, stopped: () => stopped })
  assert.deepEqual(outcomes.map(({ name, state }) => `${name} ${state}`), ["broken failed", "b loaded", "c left"])
  assert.deepEqual(log, ["b began", "b ended"])
})

test("only harnesses installed and used on this device are warmed, the host's own pieces first", () => {
  const log: string[] = []
  const driver = (provider: string, installed: boolean, warm = true) => ({ provider, available: () => installed, hostWarmup: warm ? { via: "a test", pieces: [piece("package", log)] } : undefined })
  const drivers = [driver("claude", true), driver("grok", false), driver("codex", true, false), driver("devin", true)]
  const shared = [piece("Mako's MCP servers", log)]
  assert.deepEqual(warmPieces({ drivers, used: ["claude", "grok", "codex"], cwd: "/", shared }).map(({ name }) => name), ["Mako's MCP servers", "claude: package"], "not Grok (not installed), Devin (never used), and Codex has none of its own")
  assert.deepEqual(warmPieces({ drivers, used: ["codex"], cwd: "/", shared }).map(({ name }) => name), ["Mako's MCP servers"], "a used harness with no pieces of its own still needs the host's")
  assert.deepEqual(warmPieces({ drivers, used: [], cwd: "/", shared }), [], "nothing was ever started here: nothing is loaded, the host's own pieces neither")
  assert.deepEqual(warmPieces({ drivers, used: ["grok"], cwd: "/", shared }), [], "a harness that isn't installed loads nothing")
})

test("a warm-up asked for while one runs is that one, and the next reads what to load again", async () => {
  const log: string[] = []
  const front = foreground()
  const gate = Promise.withResolvers<void>()
  let asked = 0
  const warmer = new HostWarmer(() => { asked += 1; return [piece(`run ${asked}`, log, () => gate.promise)] }, { busy: front.busy, idle: front.idle })
  const first = warmer.warm("the host is ready")
  const second = warmer.warm("a message is being written")
  assert.equal(first, second)
  gate.resolve()
  await first
  await warmer.warm("a message is being written")
  assert.equal(asked, 2)
  assert.deepEqual(log, ["run 1 began", "run 1 ended", "run 2 began", "run 2 ended"])
})
