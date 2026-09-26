import assert from "node:assert/strict"
import { ControlFault } from "@mako/control/control"
import { ControlSessions } from "../electron/control-sessions.js"

const stale = new ControlSessions(async () => undefined, async () => {
  throw new ControlFault("incompatible-session", "CLI and running engine builds differ.", "not-dispatched")
})
const refused = await stale.startOptional("binding")
assert.ok("unavailable" in refused, "a stale host starts the agent without Local Control")
assert.match(refused.unavailable, /Restart Mako/)
assert.equal(stale.get("binding"), undefined)
assert.ok("unavailable" in await stale.startOptional("binding"), "a refused start leaves the binding free to try again")

const broken = new ControlSessions(async () => undefined, async () => {
  throw new Error("Local Control session startup timed out")
})
const failed = await broken.startOptional("binding")
assert.ok("unavailable" in failed)
assert.doesNotMatch(failed.unavailable, /Restart Mako/, "only a build mismatch asks for a restart")
console.log("PASS: Local Control start failures leave the agent session running without it")
