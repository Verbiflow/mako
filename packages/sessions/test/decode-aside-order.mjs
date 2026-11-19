import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DecodeAside } from "../dist/decode-aside.js"
import { homePlace, SAVED_HISTORY_READERS } from "../dist/readers.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { ViewCache } from "../dist/view-cache.js"

// Large records decode aside, one at a time. A decode someone waits on (a Thread opening) goes before every decode
// in the background, and stops one running: after an update to a decoder the sync daemon rebuilt every large Thread's
// view one by one, and the Thread the person opened waited behind them all, 13 to 18 s (2026-11-19).
const root = await mkdtemp(join(tmpdir(), "mako-decode-aside-order-"))
try {
  const home = join(root, "home")
  const cwd = join(home, "work")
  const folder = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
  await mkdir(folder, { recursive: true })
  const reader = SAVED_HISTORY_READERS.findIndex((make) => make(new NativeStores(false), homePlace(home)).harness === "claude")
  const viewsPath = join(root, "views")
  /** A Claude session of `turns` exchanges, long enough that its decode is still running when the next is asked for. */
  const session = async (name, turns) => {
    const id = `00000000-0000-4000-8000-${name.padStart(12, "0")}`
    const lines = []
    for (let turn = 0; turn < turns; turn++) {
      const at = new Date(Date.UTC(2026, 10, 19, 0, 0, turn)).toISOString()
      lines.push(JSON.stringify({ type: "user", uuid: `${name}-u${turn}`, sessionId: id, cwd, timestamp: at, message: { role: "user", content: `Turn ${turn} ${"word ".repeat(60)}` } }))
      lines.push(JSON.stringify({ type: "assistant", uuid: `${name}-a${turn}`, sessionId: id, cwd, timestamp: at, message: { id: `${name}-m${turn}`, role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "reply ".repeat(200) }] } }))
    }
    const path = join(folder, `${id}.jsonl`)
    await writeFile(path, lines.join("\n") + "\n")
    const info = await stat(path)
    return { path, stamp: { bytes: info.size, mtimeMs: info.mtimeMs } }
  }
  const job = (made) => ({ reader, path: made.path, stamp: made.stamp, viewsPath, translator: "t-1", strict: false, place: homePlace(home) })
  const [first, second, third, opened] = [await session("1", 6_000), await session("2", 6_000), await session("3", 6_000), await session("4", 200)]

  const aside = new DecodeAside()
  const done = []
  const track = (name, outcome) => outcome.then((result) => {
    done.push(name)
    return result
  })
  const background = [track("first", aside.decode(job(first), true)), track("second", aside.decode(job(second), true)), track("third", aside.decode(job(third), true))]
  // The first is running when the person opens a Thread.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepEqual(aside.waiting().map((asked) => asked.background), [true, true], "two wait behind the one running")
  const person = await track("opened", aside.decode(job(opened)))
  assert.ok(person.ok, "the decode someone waits on is done")
  assert.deepEqual(done, ["opened"], "and before any decode in the background, the one running included")
  const results = await Promise.all(background)
  assert.ok(results.every((result) => result.ok), "the background's decodes are all done after it")
  assert.deepEqual(done, ["opened", "first", "second", "third"], "the stopped one goes again first of the rest")
  const views = new ViewCache(viewsPath, () => "t-1")
  for (const made of [first, second, third, opened]) assert.ok(await views.view(made.path, made.stamp), "each view is written whole")

  // A decode asked in the background and then waited on goes first, as one asked by someone does.
  const promoted = new DecodeAside()
  const order = []
  const asked = [first, second, third].map((made, index) => promoted.decode({ ...job(made), viewsPath: join(root, "views-2") }, true).then(() => order.push(index)))
  promoted.promote(third.path)
  await Promise.all(asked)
  assert.deepEqual(order, [2, 0, 1], "the one someone waits on now goes first; the one it stopped goes again next")
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log("decode aside order: someone's decode first, the background's after")
