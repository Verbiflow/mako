import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
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
  // What a scratch home holds until its disposer runs, which is after this folder's exit hook.
  for (const secret of ["home/.local/share/devin/credentials.toml", "home/.claude/.credentials.json", "home/Library/Keychains/login.keychain-db", "auth.json", "token.txt", "keys/id_ed25519", ".netrc"]) {
    mkdirSync(join(root, dirname(secret)), { recursive: true })
    writeFileSync(join(root, secret), "SYNTHETIC-NOT-A-REAL-CREDENTIAL")
  }
  mkdirSync(join(root, "home", "shots"), { recursive: true })
  writeFileSync(join(root, "home", "shots", "inside-a-home.png"), "SYNTHETIC-NOT-A-REAL-CREDENTIAL")
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
  const filesUnder = (folder, under = folder) => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(folder, entry.name), under) : [relative(under, join(folder, entry.name))]))
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
      const kept_ = filesUnder(at)
      assert.deepEqual(kept_, ["shots/failure.png"], `${how}: pictures alone are kept, nothing else a test made`)
      assert.ok(!kept_.some((file) => readFileSync(join(at, file), "utf8").includes("SYNTHETIC")), `${how}: no credential outlives its folder`)
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

    // Tests start together: sweepers racing over the same left folders never fail one.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid
    mkdirSync(join(temp, "mako-test-owned"), { recursive: true })
    for (let index = 0; index < 500; index++) {
      mkdirSync(join(temp, `left-${index}`))
      writeFileSync(join(temp, "mako-test-owned", `left-${index}`), String(gone))
    }
    const starters = Array.from({ length: 16 }, () => spawn(process.execPath, [self, "pass"], { env, stdio: ["ignore", "ignore", "pipe"] }))
    const started = await Promise.all(starters.map((starter) => new Promise((resolve) => {
      let said = ""
      starter.stderr.on("data", (bytes) => { said += bytes })
      starter.once("exit", (code) => resolve({ code, said }))
    })))
    assert.deepEqual(started.filter(({ code }) => code !== 0), [], "every test that started together ran")
    assert.equal(readdirSync(temp).filter((name) => name.startsWith("left-")).length, 0, "and what was left is gone")
    assert.deepEqual(owned(), [])

    // A new test can't leak: the guard reads whole calls, however they're spread over lines.
    const guard = join(dirname(self), "check-test-scratch.mjs")
    const fixtures = join(temp, "guard")
    mkdirSync(fixtures)
    const flagged = (name, source) => {
      writeFileSync(join(fixtures, name), source)
      const result = spawnSync(process.execPath, [guard, fixtures], { encoding: "utf8" })
      rmSync(join(fixtures, name))
      return result.status
    }
    assert.equal(flagged("test-one-ui.mjs", `const root = await mkdtemp(join(tmpdir(), "mako-x-"))\n`), 1, "one line")
    assert.equal(flagged("test-many-ui.mjs", `const root = await mkdtemp(\n  join(\n    tmpdir(),\n    "mako-x-"\n  )\n)\n`), 1, "over several lines")
    assert.equal(flagged("test-page-ui.tsx", `const root = mkdtempSync(join(tmpdir(), "mako-x-"))\n`), 1, "a TSX test")
    assert.equal(flagged("test-launch.mjs", `import { app } from "electron"\nconst root = mkdtempSync(\`\${tmpdir()}/mako-x-\`)\n`), 1, "an Electron test with no ui in its name")
    assert.equal(flagged("test-tmpdir-ui.mjs", `const root = mkdtempSync(process.env.TMPDIR + "/mako-x-")\n`), 1, "through the environment")
    assert.equal(flagged("test-inside-ui.mjs", `const folder = await mkdtemp(join(root, "rehearsal-"))\n`), 0, "a folder inside its scratch is its own")
    assert.equal(flagged("test-node.mjs", `const root = await mkdtemp(join(tmpdir(), "mako-x-"))\n`), 0, "a test with no window isn't held to it")

    // One run past its bound keeps what fits, smallest first.
    const over = run("over")
    assert.equal(existsSync(join(evidence(over.root), "huge.webm")), false, "a run's evidence past its bound is cut")
    assert.equal(existsSync(join(evidence(over.root), "shots", "failure.png")), true, "and what fits stays")
    // Many failed runs past the whole bound lose the oldest, and the newest stays.
    const runs = Array.from({ length: 12 }, () => run("large").root)
    assert.ok(heldBytes() <= 200 * 1024 * 1024, `what's kept stays bounded: ${heldBytes()} bytes`)
    assert.equal(existsSync(join(evidence(runs[0]), "large.webm")), false, "the oldest run went")
    assert.equal(existsSync(join(evidence(runs.at(-1)), "large.webm")), true, "the newest stayed")
    console.log("Test scratch: gone on success, a failure and each signal, only pictures and video kept and those bounded, SIGKILL's swept by the next test, sweepers racing harmlessly, a running test's and a named folder left, and the guard reading whole calls")
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
