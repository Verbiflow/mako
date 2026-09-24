import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { ControlSessions } from "../electron/control-sessions.js"
import { startControlService } from "../electron/control-service.js"
import { BrowserService } from "../packages/control-runtime/src/browser-service.js"
import { browserFixture } from "./browser-control-fixture.js"
import {
  applyControlEnvironment,
  controlLaunchInstructions,
} from "../electron/control-launch.js"
const run = promisify(execFile)
const fixture = await browserFixture()
const browsers = new BrowserService([fixture.definition])
const service = await startControlService(browsers, () => {})
const sessions = new ControlSessions(async () => undefined)
const reasons: string[] = []
try {
  const launch = await sessions.start(
    "binding",
    service.mint("conversation", "binding"),
    async (reason) => {
      reasons.push(reason)
      await service.revoke("conversation", "binding")
    }
  )
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    MAKO_CONTROL_URL: "must-not-leak",
    MAKO_CONTROL_TOKEN: "must-not-leak",
    MAKO_CONTROL_SESSION_FILE: "old",
  }
  applyControlEnvironment(env, launch)
  assert.equal(env.MAKO_CONTROL_TOKEN, undefined)
  assert.equal(env.MAKO_CONTROL_URL, undefined)
  assert.equal(env.MAKO_CONTROL_SESSION_FILE, launch.sessionFile)
  assert.ok(env.PATH?.startsWith(launch.bin))
  assert.ok(controlLaunchInstructions(launch).includes(launch.command))
  await run(launch.command, ["connect", "--browser", "fixture"])
  await run(launch.command, ["open", "--browser", "fixture"])
  assert.equal(fixture.targets.size, 1)
  const descriptor = JSON.parse(await readFile(launch.sessionFile, "utf8"))
  process.kill(descriptor.pid, "SIGKILL")
  const deadline = Date.now() + 10000
  while (fixture.targets.size > 0 || reasons.length === 0) {
    assert.ok(
      Date.now() < deadline,
      "Lost worker must release browser ownership"
    )
    await delay(20)
  }
  assert.deepEqual(reasons, ["failed"])
  assert.equal(sessions.get("binding"), undefined)
  await sessions.close()
  await assert.rejects(sessions.start("late"), /closing/)
  applyControlEnvironment(env)
  assert.equal(env.MAKO_CONTROL_SESSION_FILE, undefined)
  console.log(
    "Desktop owner: exact CLI environment without browser credentials, lost-worker browser cleanup, late-start refusal"
  )
} finally {
  await sessions.close()
  await service.close()
  browsers.close()
  await fixture.close()
}
