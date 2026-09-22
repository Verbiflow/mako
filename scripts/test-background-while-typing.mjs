import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

assert.ok(
  process.argv.includes("--allow-foreground"),
  "This test activates a disposable typing window. Run with --allow-foreground only when that foreground test has been authorized."
)
const browserJob = process.argv.includes("--browser")
assert.ok(
  browserJob || process.env.MAKO_TEST_DRIVER,
  "Set MAKO_TEST_DRIVER to the signed candidate executable"
)
const root = await mkdtemp("/private/tmp/mako-typing-job-"),
  run = promisify(execFile)
// Compile before taking the foreground; build latency is outside the typing run.
if (!browserJob) await run(
  "xcrun",
  [
    "swiftc",
    "-O",
    "scripts/lib/background-job-fixture.swift",
    "-o",
    join(root, "background"),
  ],
  { timeout: 180000 }
)
await run(
  "xcrun",
  [
    "swiftc",
    "-O",
    "scripts/lib/foreground-typing-fixture.swift",
    "-o",
    join(root, "typing"),
  ],
  { timeout: 180000 }
)
const statePath = join(root, "typing.json"),
  evidence = {}
const fixture = spawn(join(root, "typing"), [statePath, "--activate"], {
  stdio: "ignore",
})
const read = async () => JSON.parse(await readFile(statePath, "utf8"))
async function until(check) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    try {
      const s = await read()
      if (check(s)) return s
    } catch {}
    await new Promise((r) => setTimeout(r, 40))
  }
  throw Error("Typing fixture condition timed out")
}
// Bound foreground occupancy even if a background transport stalls.
const deadline = setTimeout(() => {
  evidence.deadlineExceeded = true
  fixture.kill()
}, browserJob ? 90000 : 45000)
try {
  evidence.before = await until((s) => s.started && s.received >= 10)
  const job = await run(
    process.execPath,
    [browserJob ? "scripts/test-background-browser-job.mjs" : "scripts/test-background-native-job.mjs"],
    {
      env: {
        ...process.env,
        MAKO_TEST_EXTENSION_ONLY: browserJob ? "1" : undefined,
        MAKO_TEST_BROWSER_ROUNDS: browserJob ? "24" : undefined,
        MAKO_TEST_NATIVE_FIXTURE: join(root, "background"),
      },
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
    }
  )
  await writeFile(join(root, browserJob ? "browser-job.log" : "native-job.log"), job.stdout + job.stderr)
  await writeFile(statePath + ".stop", "stop")
  evidence.after = await until((s) => s.stopped && s.sent === s.received)
  assert.ok(
    !evidence.deadlineExceeded,
    "Background jobs must finish within the foreground test window"
  )
  assert.deepEqual(
    evidence.after.failures,
    [],
    "No foreground loss, responder change or modifier contamination"
  )
  assert.ok(
    evidence.after.received - evidence.before.received >= 100,
    "Typing must continue during the background jobs"
  )
  evidence.status = "passed"
  console.log(
    `PASS: complete ${browserJob ? "extension browser" : "native"} jobs during independently counted foreground typing; all tagged keys received`
  )
} catch (error) {
  evidence.status = "failed"
  evidence.error = String(error)
  evidence.after = await read().catch(() => null)
  throw error
} finally {
  clearTimeout(deadline)
  fixture.kill()
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2)
  )
  console.log("Evidence:", root)
}
