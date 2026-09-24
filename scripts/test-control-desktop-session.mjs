import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { access, stat } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { startDesktopControlSession } from "../packages/control-runtime/dist/session.js"
const run = promisify(execFile)
async function absent(path) {
  const deadline = Date.now() + 20000
  while (
    await access(path).then(
      () => true,
      () => false
    )
  ) {
    assert.ok(Date.now() < deadline, `Cleanup failed: ${path}`)
    await delay(20)
  }
}
const started = performance.now()
const owner = await startDesktopControlSession(
  { taskId: "desktop-lifecycle" },
  {
    env: {
      ...process.env,
      MAKO_CONTROL_URL: "http://127.0.0.1:1",
      MAKO_CONTROL_TOKEN: "must-not-inherit",
      MAKO_CREDENTIAL_CANARY: "must-not-inherit",
    },
  }
)
try {
  assert.equal((await stat(owner.launch.bin)).mode & 0o777, 0o700)
  assert.equal((await stat(owner.launch.command)).mode & 0o777, 0o700)
  assert.equal((await stat(owner.launch.sessionFile)).mode & 0o777, 0o600)
  const status = JSON.parse(
    (await run(owner.launch.command, ["status"])).stdout
  )
  assert.equal(status.native.configured, false)
  assert.equal(status.browser.configured, false)
  const before = performance.now()
  const helps = await Promise.all(
    [[], ["shot"], ["record"], ["exec"], ["session", "start"]].map((args) =>
      run(owner.launch.command, [...args, "--help", "--json"], {
        env: { PATH: process.env.PATH },
      })
    )
  )
  for (const help of helps) assert.ok(JSON.parse(help.stdout))
  const helpMs = performance.now() - before
  // Execute via stdin; unlike execFile, spawn lets us supply a program without a temporary file.
  async function exec(source) {
    const child = spawn(owner.launch.command, ["exec", "--source-file", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = "",
      stderr = ""
    child.stdout.on("data", (bytes) => (stdout += bytes))
    child.stderr.on("data", (bytes) => (stderr += bytes))
    child.stdin.end(source)
    const code = await new Promise((done, reject) => {
      child.once("error", reject)
      child.once("close", done)
    })
    assert.equal(code, 0, stderr)
    return JSON.parse(stdout).at(-1).value
  }
  assert.equal(
    await exec('state.exact="  日本語 🧪 é  ";return state.exact'),
    "  日本語 🧪 é  "
  )
  assert.equal(await exec("return state.exact"), "  日本語 🧪 é  ")
  assert.equal(
    JSON.parse((await run(owner.launch.command, ["session", "stop"])).stdout)
      .stopped,
    true
  )
  await absent(owner.launch.bin)
  console.log(
    JSON.stringify({
      desktop: true,
      startAndChecksMs: performance.now() - started,
      parallelHelpMs: helpMs,
    })
  )
} finally {
  await owner.close()
}
const killed = await startDesktopControlSession({ taskId: "killed-worker" })
process.kill(killed.pid, "SIGKILL")
await absent(killed.launch.bin)
await killed.close()
const module = pathToFileURL(
  resolve("packages/control-runtime/dist/session.js")
).href
const parent = spawn(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `import {startDesktopControlSession} from ${JSON.stringify(module)};const owner=await startDesktopControlSession({taskId:'killed-parent'});console.log(JSON.stringify(owner.launch));`,
  ],
  { stdio: ["ignore", "pipe", "pipe"] }
)
const launch = await new Promise((done, reject) => {
  let text = ""
  parent.stdout.on("data", (bytes) => {
    text += bytes
    if (text.includes("\n")) done(JSON.parse(text.split("\n")[0]))
  })
  parent.once("error", reject)
})
parent.kill("SIGKILL")
await absent(launch.bin)
console.log(
  "Desktop lifecycle: exact values survive separate CLI processes; offline command help, explicit stop, worker crash and parent crash clean up private launch files"
)
