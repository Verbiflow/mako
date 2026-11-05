// Mako's one way to write a whole file (`base/published-files.ts`), in
// processes of its own on real files:
// - a writer killed with half its bytes staged leaves the file as it was, frees
//   the folder at once, and the next writer there deletes what it staged;
// - writers in several processes replacing one file never let a reader see
//   anything but a whole record, and leave nothing staged behind;
// - a file that must not exist yet is created once, and the second writer gets
//   EEXIST with the first's bytes kept;
// - a folder that's another program's gets no lock file, and nothing staged;
// - a synchronous writer waits for another process placing the same file, gives
//   up with FileLockBusyError once its wait runs out, and writes once it's free;
// - nothing is locked while bytes are staged: an asynchronous write stalled
//   mid-stream never makes a synchronous save of the same folder, or of the same
//   file, wait, fail, or lose its write (the real Fin settings store).
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path, { join } from "node:path"
import { fileURLToPath } from "node:url"
import { FileLockBusyError, withFileLock, withFileLockSync } from "@mako/host/base/file-lock"
import { publishFile, publishFileSync, publisherFile } from "@mako/host/base/published-files"
import { FinDefaultsStore } from "@mako/host/harnesses/fin-defaults"

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const worker = join(repo, "scripts/lib/published-files-worker.ts")

function start(job: { mode: "publish" | "stall"; file: string; tag: string; count?: number }) {
  const child = spawn(process.execPath, ["--import", "tsx", worker], {
    cwd: repo,
    env: { ...process.env, NODE_OPTIONS: "", CASE: JSON.stringify({ count: 0, ...job }) },
    stdio: ["ignore", "pipe", "inherit"],
  })
  let out = ""
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString() })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })))
  return {
    done: () => exited,
    stalled: () => new Promise<void>((resolve) => {
      const look = () => { if (out.includes("stalled")) { child.stdout.off("data", look); resolve() } }
      child.stdout.on("data", look)
      look()
    }),
    async kill() {
      child.kill("SIGKILL")
      assert.deepEqual(await exited, { code: null, signal: "SIGKILL" })
    },
  }
}

const staged = (folder: string) => readdirSync(folder).filter((name) => /\.mako-\d+(-[0-9a-f]+)?\.tmp$/.test(name))

const root = mkdtempSync(join(tmpdir(), "mako-published-files-"))
try {
  {
    const folder = join(root, "killed")
    const file = join(folder, "state.json")
    await publishFile(file, JSON.stringify({ tag: "before" }), { mode: 0o600, dirMode: 0o700 })
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(folder).mode & 0o777, 0o700)
    const writer = start({ mode: "stall", file, tag: "killed" })
    await writer.stalled()
    assert.equal(staged(folder).length, 1, "the killed writer's bytes are staged beside the file")
    await writer.kill()
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { tag: "before" }, "a writer killed mid-write leaves the file as it was")
    const started = Date.now()
    await publishFile(file, JSON.stringify({ tag: "after" }), { waitMs: 300 })
    assert.ok(Date.now() - started < 300, "the killed writer's lock went with it")
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { tag: "after" })
    assert.deepEqual(staged(folder), [], "the next writer deleted what the dead one staged")
  }

  {
    const folder = join(root, "contended")
    const file = join(folder, "state.json")
    await publishFile(file, JSON.stringify({ tag: "seed", index: -1 }))
    const writers = ["a", "b", "c"].map((tag) => start({ mode: "publish", file, tag, count: 40 }))
    let finished = false
    const all = Promise.all(writers.map((writer) => writer.done())).finally(() => { finished = true })
    let reads = 0
    const seen = new Set<string>()
    while (!finished) {
      // SAFETY: every writer publishes this record; a torn one fails to parse first.
      const record = JSON.parse(readFileSync(file, "utf8")) as { tag: string; index: number }
      seen.add(record.tag)
      reads++
      await new Promise((resolve) => setImmediate(resolve))
    }
    for (const ended of await all) assert.deepEqual(ended, { code: 0, signal: null })
    // SAFETY: as above, a whole record or a parse failure.
    const last = JSON.parse(readFileSync(file, "utf8")) as { index: number }
    assert.equal(last.index, 39, "the file holds one writer's last record, whole")
    assert.ok(reads > 0 && seen.size > 0)
    assert.deepEqual(staged(folder), [], "nothing staged is left behind")
    assert.deepEqual(readdirSync(folder).filter((name) => !publisherFile(name)), ["state.json"])
  }

  {
    const folder = join(root, "exclusive")
    const file = join(folder, "home.json")
    await publishFile(file, "first", { exclusive: true })
    await assert.rejects(publishFile(file, "second", { exclusive: true }), { code: "EEXIST" })
    assert.throws(() => publishFileSync(file, "third", { exclusive: true }), { code: "EEXIST" })
    assert.equal(readFileSync(file, "utf8"), "first")
    assert.deepEqual(staged(folder), [])
  }

  {
    const folder = join(root, "foreign")
    const file = join(folder, "auth.json")
    await publishFile(file, "{}", { foreignFolder: true })
    publishFileSync(file, "{\"a\":1}", { foreignFolder: true })
    assert.deepEqual(readdirSync(folder), ["auth.json"], "no lock file and nothing staged in another program's folder")
    assert.equal(readFileSync(file, "utf8"), "{\"a\":1}")
  }

  {
    const folder = join(root, "sync")
    const file = join(folder, "choices.json")
    publishFileSync(file, "one")
    assert.equal(readFileSync(file, "utf8"), "one")
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    let holding: () => void = () => undefined
    const locked = new Promise<void>((resolve) => { holding = resolve })
    const holder = withFileLock(`${file}.mako-place-lock`, async () => { holding(); await held })
    await locked
    assert.throws(() => publishFileSync(file, "two", { waitMs: 100 }), FileLockBusyError, "the file's holder keeps a synchronous writer out")
    await assert.rejects(publishFile(file, "two", { waitMs: 100 }), FileLockBusyError)
    assert.equal(readFileSync(file, "utf8"), "one")
    publishFileSync(join(folder, "other.json"), "unrelated", { waitMs: 100 })
    assert.equal(readFileSync(join(folder, "other.json"), "utf8"), "unrelated", "a lock on one file doesn't hold up another in its folder")
    release()
    await holder
    publishFileSync(file, "two")
    assert.equal(readFileSync(file, "utf8"), "two")
  }

  {
    // A write stalled mid-stream holds nothing: not its file's lock, and not its folder's.
    const folder = join(root, "stalled")
    const profiles = join(folder, "provider-profiles.json")
    const defaults = join(folder, "fin-defaults.json")
    const store = new FinDefaultsStore(defaults)
    store.setLimit(2)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered: () => void = () => undefined
    const streaming = new Promise<void>((resolve) => { entered = resolve })
    const writer = publishFile(profiles, (async function* () {
      yield Buffer.from("{")
      entered()
      await gate
      yield Buffer.from("}")
    })())
    try {
      await streaming
      // The same host's synchronous save, in the same folder, while the other is stalled: no wait, no refusal.
      const began = performance.now()
      store.setLimit(3)
      const took = performance.now() - began
      assert.equal(store.reading().limit, 3)
      assert.equal(JSON.parse(readFileSync(defaults, "utf8")).limit, 3, "the save reached the disk, not only the cache")
      assert.ok(took < 1_000, `the save took ${Math.round(took)} ms behind a stalled write, which holds no lock`)
      // And the stalled write's own file is free to a synchronous writer too: nothing is locked until its rename.
      assert.doesNotThrow(() => withFileLockSync(`${profiles}.mako-place-lock`, () => undefined, { waitMs: 50 }), "a write still staging holds its file's lock")
      publishFileSync(profiles, "{\"sync\":true}", { waitMs: 100 })
      assert.equal(readFileSync(profiles, "utf8"), "{\"sync\":true}")
    } finally {
      release()
    }
    await writer
    assert.equal(readFileSync(profiles, "utf8"), "{}", "the stalled write placed whole once it finished")
    assert.deepEqual(readdirSync(folder).filter((name) => !publisherFile(name)).sort(), ["fin-defaults.json", "provider-profiles.json"])
    assert.deepEqual(staged(folder), [])
  }

  {
    const folder = join(root, "leftover")
    const file = join(folder, "state.json")
    await publishFile(file, "kept")
    // A pid that ran and ended is a writer that is gone; this process and its parent are writers that aren't.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid
    writeFileSync(join(folder, `other.json.mako-${gone}-0badf00d.tmp`), "half")
    writeFileSync(join(folder, `live.json.mako-${process.pid}-0badf00d.tmp`), "being written here")
    writeFileSync(join(folder, `live.json.mako-${process.ppid}-0badf00d.tmp`), "being written elsewhere")
    writeFileSync(join(folder, "notes.tmp"), "someone else's")
    publishFileSync(file, "new")
    assert.ok(!existsSync(join(folder, `other.json.mako-${gone}-0badf00d.tmp`)), "a dead writer's staged file goes at the next write, whatever file it was for")
    assert.ok(existsSync(join(folder, `live.json.mako-${process.pid}-0badf00d.tmp`)), "this process's staged file stays")
    assert.ok(existsSync(join(folder, `live.json.mako-${process.ppid}-0badf00d.tmp`)), "a live writer's staged file stays")
    assert.ok(existsSync(join(folder, "notes.tmp")), "files the publisher didn't stage stay")
    assert.equal(publisherFile(`live.json.mako-${process.ppid}-0badf00d.tmp`), true, "a staged file is the publisher's, whoever's folder it is in")
    assert.equal(publisherFile("state.json.mako-place-lock"), true)
    assert.equal(publisherFile("state.json.mako-place-lock-journal"), true)
    assert.equal(publisherFile("state.json"), false)
  }

  console.log("published files: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
