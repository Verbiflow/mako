import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Run as a child, a test's body: makes a scratch folder, fills it, says where, ends as it's told.
if (process.argv[2]) {
  const { testScratch } = await import("./lib/test-scratch.mjs")
  const how = process.argv[2]
  const root = testScratch("mako-scratch-proof-", { ...(how === "given" && { given: process.argv[3] }) })
  mkdirSync(join(root, "profile"), { recursive: true })
  writeFileSync(join(root, "profile", "cookies"), "x".repeat(1_000))
  mkdirSync(join(root, "cache"), { recursive: true })
  writeFileSync(join(root, "cache", "bundle.js"), "x".repeat(1_000))
  mkdirSync(join(root, "shots"), { recursive: true })
  writeFileSync(join(root, "shots", "failure.png"), "evidence")
  writeFileSync(join(root, "result.json"), "{}")
  if (how === "over") writeFileSync(join(root, "huge.webm"), Buffer.alloc(30 * 1024 * 1024))
  if (how === "large") writeFileSync(join(root, "large.webm"), Buffer.alloc(20 * 1024 * 1024))
  console.log(`ROOT ${root}`)
  if (how === "throw" || how === "over" || how === "large") throw new Error("the test failed")
  if (how === "exit-code") process.exitCode = 3
  if (how === "stay" || how === "stay-child") {
    if (how === "stay-child") {
      // A wrapper with a child of its own, as `.bin/electron` is: it passes SIGTERM on, and SIGKILL would orphan its child.
      const wrapper = `const c=require("child_process").spawn("sleep",["60"],{stdio:"ignore"});console.log(c.pid);process.on("SIGTERM",()=>{c.kill("SIGTERM");process.exit(0)});setInterval(()=>{},1000)`
      const child = spawn(process.execPath, ["-e", wrapper], { stdio: ["ignore", "pipe", "inherit"] })
      child.stdout.once("data", (pid) => console.log(`CHILD ${String(pid).trim()}`))
    }
    setInterval(() => undefined, 1_000)
  }
} else {
  const self = fileURLToPath(import.meta.url)
  const temp = mkdtempSync(join(tmpdir(), "mt-"))
  const env = { ...process.env, TMPDIR: temp, MAKO_KEEP_TEST_SCRATCH: "" }
  const kept = join(temp, "mako-test-kept")
  const rootOf = (stdout) => /^ROOT (.+)$/m.exec(stdout)?.[1]
  const run = (how, ...rest) => {
    const result = spawnSync(process.execPath, [self, how, ...rest], { encoding: "utf8", env })
    return { ...result, root: rootOf(result.stdout) }
  }
  const owned = () => (existsSync(join(temp, "mako-test-owned")) ? readdirSync(join(temp, "mako-test-owned")) : [])
  const evidence = (root) => join(kept, root.split("/").at(-1))
  const sizeOf = (path) => (statSync(path).isDirectory() ? readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0) : statSync(path).size)
  const heldBytes = () => sizeOf(kept)
  const stopped = async (how, signal) => {
    const child = spawn(process.execPath, [self, how], { env, stdio: ["ignore", "pipe", "inherit"] })
    let out = ""
    child.stdout.on("data", (bytes) => { out += bytes })
    const hung = Date.now() + 15_000
    while (!rootOf(out) || (how === "stay-child" && !/CHILD/.test(out))) {
      assert.ok(Date.now() < hung, "the child said where its folder is")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const ended = new Promise((resolve) => child.once("exit", resolve))
    child.kill(signal)
    return { code: await ended, root: rootOf(out), out }
  }
  try {
    const passed = run("pass")
    assert.equal(passed.status, 0, passed.stderr)
    assert.equal(existsSync(passed.root), false, "a passing run leaves nothing")
    assert.equal(existsSync(kept), false, "and keeps nothing")
    assert.deepEqual(owned(), [], "and no note of it")

    for (const [how, code] of [["throw", 1], ["exit-code", 3]]) {
      const failed = run(how)
      assert.equal(failed.status, code)
      assert.equal(existsSync(failed.root), false, `${how}: the folder goes`)
      const at = evidence(failed.root)
      assert.equal(existsSync(join(at, "shots", "failure.png")), true, `${how}: its shots are kept`)
      assert.equal(existsSync(join(at, "result.json")), true, `${how}: its results are kept`)
      assert.equal(existsSync(join(at, "profile")), false, `${how}: its profile isn't`)
      assert.equal(existsSync(join(at, "cache")), false, `${how}: its cache isn't`)
      assert.match(failed.stderr, /Kept from this failed run/)
    }

    for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]]) {
      const ended = await stopped("stay", signal)
      assert.equal(ended.code, code, `${signal} still ends it as a failure`)
      assert.equal(existsSync(ended.root), false, `${signal}: the folder goes`)
      assert.equal(existsSync(join(evidence(ended.root), "shots", "failure.png")), true, `${signal}: its evidence stays`)
    }

    // A stopped Electron can write once more after the folder has gone; the next test removes what that made.
    const late = await stopped("stay", "SIGTERM")
    mkdirSync(join(late.root, "profile"), { recursive: true })
    assert.equal(run("pass").status, 0)
    assert.equal(existsSync(late.root), false, "what a late write made goes with the next test")
    assert.deepEqual(owned(), [], "and its note")

    const withChild = await stopped("stay-child", "SIGTERM")
    const child = Number(/^CHILD (\d+)$/m.exec(withChild.out)?.[1])
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.throws(() => process.kill(child, 0), /ESRCH/, "a signal reaches the child under a wrapper, that was writing there")

    const shot = await stopped("stay", "SIGKILL")
    assert.equal(existsSync(shot.root), true, "SIGKILL runs nothing")
    assert.equal(run("pass").status, 0)
    assert.equal(existsSync(shot.root), false, "the next test removes what it left")
    assert.deepEqual(owned(), [])

    const stillRunning = spawn(process.execPath, [self, "stay"], { env, stdio: ["ignore", "pipe", "inherit"] })
    let said = ""
    stillRunning.stdout.on("data", (bytes) => { said += bytes })
    while (!rootOf(said)) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(run("pass").status, 0)
    assert.equal(existsSync(rootOf(said)), true, "a running test's folder is left alone")
    stillRunning.kill("SIGKILL")

    const named = join(temp, "from-the-workflow")
    mkdirSync(named)
    const given = run("given", named)
    assert.equal(given.root, named)
    assert.equal(existsSync(join(named, "shots", "failure.png")), true, "a folder the caller named stays, as CI's upload is")
    assert.match(given.stdout, /Test evidence: /)

    const kept2 = spawnSync(process.execPath, [self, "pass"], { encoding: "utf8", env: { ...env, MAKO_KEEP_TEST_SCRATCH: "1" } })
    assert.equal(existsSync(rootOf(kept2.stdout)), true, "told to keep it, it stays whole")
    assert.equal(existsSync(join(rootOf(kept2.stdout), "profile", "cookies")), true)

    // One run past its bound keeps what fits, smallest first.
    const over = run("over")
    assert.equal(existsSync(join(evidence(over.root), "huge.webm")), false, "a run's evidence past its bound is cut")
    assert.equal(existsSync(join(evidence(over.root), "shots", "failure.png")), true, "and what fits stays")
    // Many failed runs past the whole bound lose the oldest, and the newest stays.
    const runs = Array.from({ length: 12 }, () => run("large").root)
    assert.ok(heldBytes() <= 200 * 1024 * 1024, `what's kept stays bounded: ${heldBytes()} bytes`)
    assert.equal(existsSync(join(evidence(runs[0]), "large.webm")), false, "the oldest run went")
    assert.equal(existsSync(join(evidence(runs.at(-1)), "large.webm")), true, "the newest stayed")
    console.log("Test scratch: gone on success, a failure and each signal, evidence kept without its profile or cache and bounded, SIGKILL's swept by the next test, a running test's and a named folder left")
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
