import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BrowserService } from "@mako/control-runtime/browser"
import { MACHINE_BROWSER_ID, MachineBrowser } from "@mako/control-runtime/desktop"

/**
 * A machine's own Chromium: nothing runs until an agent connects, concurrent connects start one process, a stale
 * DevTools port file is ignored, it starts again after it exits, a start that fails says why and the next connect
 * tries again, it is preferred until someone chooses, and closing stops it.
 */
const root = await mkdtemp(join(tmpdir(), "mako-machine-browser-"))
const log = join(root, "launches.jsonl")
const executable = resolve("scripts/fixtures/fake-chromium.mjs")
await chmod(executable, 0o755)
process.env.FAKE_CHROMIUM_LOG = log
const launches = async (): Promise<{ pid: number; args: string[] }[]> =>
  existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) : []
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (condition: () => boolean | Promise<boolean>, what: string) => {
  for (const deadline = Date.now() + 5000; Date.now() < deadline; await delay(10)) if (await condition()) return
  assert.fail(`timed out waiting until ${what}`)
}

const profile = join(root, "profile")
await mkdir(profile)
await writeFile(join(profile, "DevToolsActivePort"), "1\n/devtools/browser/stale\n")
const machine = new MachineBrowser({ executable, profile })
const browser = new BrowserService(() => [machine.definition], {
  preferencePath: join(root, "preference.json"),
  defaultBrowser: MACHINE_BROWSER_ID,
})
const statuses = await browser.refresh()
assert.deepEqual(statuses.map(({ id, preferred, connection }) => ({ id, preferred, status: connection.status })), [
  { id: MACHINE_BROWSER_ID, preferred: true, status: "disconnected" },
])
assert.equal((await launches()).length, 0, "nothing runs until an agent connects")

await Promise.all([browser.connect(MACHINE_BROWSER_ID), browser.connect(MACHINE_BROWSER_ID)])
const [first] = await launches()
assert.equal((await launches()).length, 1, "concurrent connects start one Chromium")
assert.ok(first!.args.includes("--headless"))
assert.ok(first!.args.includes(`--user-data-dir=${profile}`))
assert.ok(first!.args.includes("--remote-debugging-port=0"))
assert.ok(!first!.args.includes("--no-sandbox"), "the sandbox stays on unless the machine can't give it")
assert.ok(!existsSync(join(profile, "DevToolsActivePort")), "a killed Chromium's port file is never read")
assert.equal(browser.status()[0]!.connection.status, "connected")

process.kill(first!.pid, "SIGKILL")
await until(() => browser.status()[0]!.connection.status === "disconnected", "the connection notices Chromium exited")
await browser.connect(MACHINE_BROWSER_ID)
const relaunched = await launches()
assert.equal(relaunched.length, 2, "the next connect starts it again")
assert.notEqual(relaunched[1]!.pid, first!.pid)

machine.close()
await until(() => !alive(relaunched[1]!.pid), "closing stops Chromium")
await assert.rejects(machine.definition.endpoint(), /shutting down/)
browser.close()

process.env.FAKE_CHROMIUM_MODE = "fail"
const failing = new MachineBrowser({ executable, profile: join(root, "failing") })
await assert.rejects(failing.definition.endpoint(), /can't start its sandbox: this machine refuses to create user namespaces/)
await assert.rejects(failing.definition.endpoint(), /refuses to create user namespaces/)
assert.equal((await launches()).length, 4, "a failed start isn't remembered: the next connect tries again")
failing.close()
delete process.env.FAKE_CHROMIUM_MODE

const unsandboxed = new MachineBrowser({ executable, profile: join(root, "root"), sandbox: false })
await unsandboxed.definition.endpoint()
assert.ok((await launches()).at(-1)!.args.includes("--no-sandbox"), "a host running as root runs Chromium without its sandbox, which refuses root")
unsandboxed.close()

await rm(root, { recursive: true, force: true })
console.log(
  "Machine browser: nothing runs until a connect, one launch for concurrent connects, stale port file ignored, relaunch after exit, a refused sandbox explained and retried, preferred by default, closing stops it passed"
)
