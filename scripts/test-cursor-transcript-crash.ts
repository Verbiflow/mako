// A Cursor child killed, or just slow, while it writes a transcript. The patched
// SDK's writers, cut from the installed bundle (esm and cjs), run in processes
// of their own on real files:
// - a full rewrite killed at its first or a later chunk leaves the published
//   transcript as it was, and the next open removes what it staged;
// - a rewrite is published by rename and the folder is synced after it, in
//   that order, and a folder that can't be synced fails the write unless the
//   platform has no such thing;
// - an append killed mid-line is cut back by whoever takes the lock from the
//   dead writer, a writer or an opening child, with no model turn between;
// - a child opening an agent while another is mid-append waits for it and
//   leaves its line whole; a writer that stays locked leaves the file alone;
// - a lock is stale only when its owner's pid and start time name no live process.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as promises from "node:fs/promises"
import { tmpdir } from "node:os"
import path, { join } from "node:path"
import { fileURLToPath } from "node:url"
import { cursorTranscriptFolder, repairCursorTranscripts } from "@mako/host/harnesses/cursor/sdk/transcript-tails"
import { processStart, withTranscriptLock } from "@mako/host/harnesses/cursor/sdk/transcript-lock"
import { BUILDS, jsonl, loadWriters, rowsOf, type Build } from "./lib/cursor-transcript-writers.js"

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const worker = join(repo, "scripts/lib/cursor-transcript-worker.ts")

interface Job { build: Build; mode: "append" | "rewrite"; file: string; from: number; count: number; tag: string; stall: number; finish?: boolean }

/** A child process writing, kept so a test can let it finish or kill it. */
function start(job: Job) {
  const child = spawn(process.execPath, ["--import", "tsx", worker], {
    cwd: repo,
    env: { ...process.env, NODE_OPTIONS: "", CASE: JSON.stringify({ finish: false, ...job }) },
    stdio: ["pipe", "pipe", "inherit"],
  })
  let out = ""
  const seen = (text: string) => new Promise<void>((resolve) => {
    const look = () => { if (out.includes(text)) { child.stdout.off("data", look); resolve() } }
    child.stdout.on("data", look)
    look()
  })
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString() })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })))
  return {
    child,
    out: () => out,
    stalled: () => seen("stalled"),
    done: () => exited,
    go: () => child.stdin.write("go\n"),
    async kill() {
      child.kill("SIGKILL")
      assert.deepEqual(await exited, { code: null, signal: "SIGKILL" })
    },
  }
}

async function run(job: Job): Promise<string> {
  const writer = start(job)
  const ended = await writer.done()
  assert.deepEqual(ended, { code: 0, signal: null }, `${job.mode} finished`)
  return writer.out()
}

const settled = async (promise: Promise<unknown>) => {
  let done = false
  void promise.then(() => { done = true }, () => { done = true })
  await new Promise((resolve) => setTimeout(resolve, 400))
  return done
}

const root = mkdtempSync(join(tmpdir(), "mako-cursor-transcripts-"))
try {
  const folder = cursorTranscriptFolder("/Users/someone/My Repo", "agent-1", {}, root)
  assert.equal(folder, join(root, ".cursor/projects/Users-someone-My-Repo/agent-transcripts/agent-1"))
  assert.equal(cursorTranscriptFolder("/w", "a/b", { CURSOR_DATA_DIR: "/data" }, root), "/data/projects/w/agent-transcripts/a_2Fb")
  mkdirSync(join(folder, "subagents"), { recursive: true })
  const primary = join(folder, "agent-1.jsonl")
  const child = join(folder, "subagents", "child-1.jsonl")
  const before = jsonl(rowsOf(0, 20, "old"))
  const leftovers = () => [...readdirSync(folder), ...readdirSync(join(folder, "subagents"))].filter((name) => name.includes(".mako-"))
  const valid = (file: string) => { for (const line of readFileSync(file, "utf8").trimEnd().split("\n")) JSON.parse(line) }

  for (const build of BUILDS) {
    // A full rewrite killed at its first chunk, then at a later one.
    for (const stall of [0, 1]) {
      writeFileSync(primary, before)
      const writer = start({ build, mode: "rewrite", file: primary, from: 0, count: 20, tag: "new", stall })
      await writer.stalled()
      await writer.kill()
      assert.equal(readFileSync(primary, "utf8"), before, `${build}: a rewrite killed at chunk ${stall} leaves the published transcript whole`)
      assert.ok(leftovers().some((name) => /\.mako-\d+\.tmp$/.test(name)), "the killed rewrite's staged file is left beside it")
      assert.ok(leftovers().some((name) => name.endsWith(".mako-lock")), "and so is its lock")
      assert.deepEqual(await repairCursorTranscripts(folder), [])
      assert.deepEqual(leftovers(), [], `${build}: opening the agent removes a dead writer's staged file and lock`)
      assert.equal(readFileSync(primary, "utf8"), before)
    }

    // A full rewrite that finishes publishes all of it, in more than one chunk, and releases its lock.
    const out = await run({ build, mode: "rewrite", file: primary, from: 0, count: 20, tag: "new", stall: -1 })
    assert.ok(Number(/done (\d+)/.exec(out)?.[1]) > 1, "the rewrite streamed in several chunks")
    assert.equal(readFileSync(primary, "utf8"), jsonl(rowsOf(0, 20, "new")))
    assert.deepEqual(leftovers(), [])

    // An append killed mid-line: the next writer, taking the lock from the dead one, cuts the torn line first.
    writeFileSync(child, before)
    const killed = start({ build, mode: "append", file: child, from: 20, count: 1, tag: "old", stall: 0 })
    await killed.stalled()
    await killed.kill()
    const torn = readFileSync(child, "utf8")
    assert.ok(torn.length > before.length && !torn.endsWith("\n"), "the killed append left a torn last line")
    await run({ build, mode: "append", file: child, from: 20, count: 1, tag: "next", stall: -1 })
    assert.equal(readFileSync(child, "utf8"), before + jsonl(rowsOf(20, 1, "next")), `${build}: the next writer cut the torn line before its own`)
    valid(child)
    assert.deepEqual(leftovers(), [])

    // The same, found by a child opening the agent instead.
    writeFileSync(child, before)
    const again = start({ build, mode: "append", file: child, from: 20, count: 1, tag: "old", stall: 0 })
    await again.stalled()
    await again.kill()
    assert.deepEqual(await repairCursorTranscripts(folder), [child])
    assert.equal(readFileSync(child, "utf8"), before, `${build}: opening the agent cuts the transcript back to its last whole line`)
    assert.deepEqual(await repairCursorTranscripts(folder), [], "a whole transcript is left alone")
    assert.deepEqual(leftovers(), [])

    // Two children: one is mid-append when the other opens the agent.
    writeFileSync(child, before)
    const slow = start({ build, mode: "append", file: child, from: 20, count: 1, tag: "live", stall: 0, finish: true })
    await slow.stalled()
    const midLine = readFileSync(child, "utf8")
    assert.ok(!midLine.endsWith("\n"), "the live writer is partway through its line")
    const opening = repairCursorTranscripts(folder)
    assert.equal(await settled(opening), false, `${build}: the opening child waits for the live writer`)
    assert.equal(readFileSync(child, "utf8"), midLine, "and leaves its half line alone")
    slow.go()
    assert.deepEqual(await opening, [], "nothing was torn once the writer finished")
    assert.deepEqual(await slow.done(), { code: 0, signal: null })
    assert.equal(readFileSync(child, "utf8"), before + jsonl(rowsOf(20, 1, "live")), `${build}: the live writer's line is whole`)
    valid(child)
    assert.deepEqual(leftovers(), [])

    // A child that can't wait that long leaves the file, and says so, while still repairing the others.
    writeFileSync(primary, before + jsonl(rowsOf(20, 1, "torn")).slice(0, 5000))
    const holding = start({ build, mode: "append", file: child, from: 21, count: 1, tag: "live", stall: 0, finish: true })
    await holding.stalled()
    const held = readFileSync(child, "utf8")
    await assert.rejects(repairCursorTranscripts(folder, { waitMs: 300 }), /left .*child-1\.jsonl/)
    assert.equal(readFileSync(child, "utf8"), held, "a file whose writer is still at it is not cut")
    assert.equal(readFileSync(primary, "utf8"), before, "the other transcript was still cut back")
    holding.go()
    await holding.done()
    rmSync(child)
    writeFileSync(primary, before)
    assert.deepEqual(leftovers(), [])
  }

  // A lock is stale when its owner's pid and start time name no live process, and not otherwise.
  writeFileSync(child, before)
  const lockFile = `${child}.mako-lock`
  const owner = (pid: number, start: string) => JSON.stringify({ pid, start, token: "other" })
  writeFileSync(lockFile, owner(process.pid, "Thu Jan  1 00:00:00 1970"))
  writeFileSync(child, `${before}{"role":"us`)
  assert.deepEqual(await repairCursorTranscripts(folder, { waitMs: 2000 }), [child], "a live pid with another start time is a reused pid: its lock is stale")
  assert.equal(readFileSync(child, "utf8"), before)
  const real = processStart(process.pid)
  assert.ok(real, "the process has a start time")
  writeFileSync(lockFile, owner(process.pid, real))
  await assert.rejects(withTranscriptLock(child, async () => undefined, undefined, { waitMs: 300 }), /being written by process/)
  assert.ok(existsSync(lockFile), "a lock whose owner's pid and start time are live is not taken")
  rmSync(lockFile)
  writeFileSync(lockFile, "")
  assert.deepEqual(await repairCursorTranscripts(folder, { waitMs: 100 }).catch(() => "waited"), "waited", "a lock being written is not taken at once")
  rmSync(lockFile)
  assert.deepEqual(await repairCursorTranscripts(folder), [])

  // A transcript holding no whole line is emptied; a missing folder is nothing to repair.
  writeFileSync(child, '{"role":"us')
  assert.deepEqual(await repairCursorTranscripts(folder), [child])
  assert.equal(readFileSync(child, "utf8"), "")
  assert.deepEqual(await repairCursorTranscripts(join(root, "absent")), [])
  assert.ok(!existsSync(join(root, "absent")))

  // Publishing a rewrite: file synced, renamed, then its folder synced; and what a folder that can't be synced does.
  const sequence: string[] = []
  let folderSync: Error | undefined
  let folderOpen: Error | undefined
  const recording = (dir: string) => ({
    ...promises,
    async open(name: string, flags: string) {
      const kind = name === dir ? "folder" : "file"
      if (kind === "folder" && folderOpen) throw folderOpen
      const handle = await promises.open(name, flags)
      sequence.push(`open ${kind}`)
      return {
        fd: handle.fd,
        writeFile: (data: string, encoding: BufferEncoding) => { sequence.push(`write ${kind}`); return handle.writeFile(data, encoding) },
        sync: async () => { sequence.push(`sync ${kind}`); await handle.sync(); if (kind === "folder" && folderSync) throw folderSync },
        close: () => { sequence.push(`close ${kind}`); return handle.close() },
      }
    },
    async writeFile(name: string, data: string, options?: object) { sequence.push(`writeFile ${path.basename(name).replace(/\.mako-\d+\.tmp$/, ".tmp")}`); return promises.writeFile(name, data, options) },
    async rename(from: string, to: string) { sequence.push("rename"); return promises.rename(from, to) },
  })
  const code = (value: string) => Object.assign(new Error(value), { code: value })
  for (const build of BUILDS) {
    const dir = join(root, `sync-${build}`)
    mkdirSync(dir)
    const file = join(dir, "t.jsonl")
    const writers = loadWriters(build, recording(dir))
    const cases: [string, () => Promise<void>][] = [
      ["a single write", () => writers.writeFile(file, "a\n")],
      ["a streamed rewrite", () => writers.rewrite(file, rowsOf(0, 3, "x"))],
    ]
    for (const [name, publish] of cases) {
      sequence.length = 0
      folderSync = folderOpen = undefined
      await publish()
      const at = (step: string) => sequence.lastIndexOf(step)
      assert.ok(at("sync file") >= 0, `${build}: ${name} syncs the file`)
      assert.ok(at("rename") > at("sync file"), `${build}: ${name} renames after syncing the file`)
      assert.ok(at("sync folder") > at("rename"), `${build}: ${name} syncs the folder after the rename: ${sequence.join(", ")}`)
      assert.ok(at("close folder") > at("sync folder"), `${build}: ${name} closes the folder it synced`)
      // A platform with no folder to open or sync (Windows, some filesystems) has nothing to sync.
      for (const failure of ["EISDIR", "EPERM", "EINVAL", "ENOTSUP", "EOPNOTSUPP"]) {
        folderOpen = failure === "EISDIR" || failure === "EPERM" ? code(failure) : undefined
        folderSync = folderOpen ? undefined : code(failure)
        await publish()
      }
      // Anything else is a write that didn't happen: it rejects, with the folder still closed.
      for (const failure of ["EIO", "ENOSPC"]) {
        folderOpen = undefined
        folderSync = code(failure)
        sequence.length = 0
        await assert.rejects(publish(), new RegExp(failure), `${build}: ${name} fails when the folder can't be synced: ${failure}`)
        assert.ok(sequence.includes("close folder"), "and the folder is closed")
        folderSync = undefined
        folderOpen = code(failure)
        await assert.rejects(publish(), new RegExp(failure), `${build}: ${name} fails when the folder can't be opened: ${failure}`)
      }
      folderOpen = undefined
    }
  }
  console.log("Cursor transcripts (esm and cjs): a killed rewrite leaves the transcript whole, a rewrite syncs its folder after the rename, a killed append is cut back by the next writer or opener, a child mid-append is waited for, and a lock is stale only when its owner is gone")
} finally {
  rmSync(root, { recursive: true, force: true })
}
