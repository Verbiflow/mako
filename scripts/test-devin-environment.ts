import assert from "node:assert/strict"
import { devinAcpSource } from "../electron/providers/devin/acp.js"

const desktop: NodeJS.ProcessEnv = { ACP_BACKEND: "windsurf", WINDSURF_IDE_TYPE: "windsurf", HOME: "/fixture", XDG_CONFIG_HOME: "/fixture/config", XDG_DATA_HOME: "/fixture/data", PATH: "/bin" }
const launch = await devinAcpSource.launch({ appPath: "/fixture/app", execPath: process.execPath, cwd: "/fixture/project" })
assert.ok(launch)
const env = { ...desktop }
launch.configureEnvironment(env)
assert.equal(env.ACP_BACKEND, undefined, "Mako must not inherit Desktop's host-authenticated backend mode")
assert.equal(env.WINDSURF_IDE_TYPE, undefined)
assert.equal(env.HOME, desktop.HOME)
assert.equal(env.XDG_CONFIG_HOME, desktop.XDG_CONFIG_HOME)
assert.equal(env.XDG_DATA_HOME, desktop.XDG_DATA_HOME)
assert.equal(desktop.ACP_BACKEND, "windsurf")
console.log("Devin ACP launch removes foreign host authentication flags and preserves the user's own CLI configuration")
