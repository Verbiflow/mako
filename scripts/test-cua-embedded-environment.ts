// The embedded driver's environment: the host passes on none of a person's own driver settings. A stand-in driver,
// found the way the host finds the real one, writes the environment it was started with; nothing in it may be a
// `CUA_DRIVER_*` or `CUA_TELEMETRY_ENABLED` variable the host did not set itself. (That the real daemon then opens no
// TCP listener is checked against it on Windows, in scripts/test-control-driver-windows.ts.)
import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { z } from "zod"
import { CuaEmbedded, driverEnvironment, driverProves } from "../packages/host/src/control/cua-embedded.js"

const Environment = z.record(z.string(), z.string())
const inherited = {
  PATH: "/usr/bin",
  HOME: "/home/someone",
  CUA_DRIVER_RS_MCP_HTTP_PORT: "8123",
  CUA_DRIVER_ENVELOPE_HTTP_PORT: "8124",
  CUA_DRIVER_PERMISSION_MODE: "unrestricted",
  CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: "1",
  cua_driver_policy_file: "/somewhere/policy.json",
  CUA_TELEMETRY_ENABLED: "1",
  CUA_DRIVERLESS: "kept: not the driver's",
}
const passed = driverEnvironment(inherited, { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_PERMISSION_MODE: "standard" })
assert.deepEqual(passed, {
  PATH: "/usr/bin",
  HOME: "/home/someone",
  CUA_DRIVERLESS: "kept: not the driver's",
  CUA_DRIVER_EMBEDDED: "1",
  CUA_DRIVER_PERMISSION_MODE: "standard",
})

// The proof handshake is asked only of a driver release that has it: an older installed driver starts as before.
assert.equal(driverProves("cua-driver 0.28.2+mako.31\n"), true)
assert.equal(driverProves("cua-driver 0.28.2+mako.100"), true)
assert.equal(driverProves("cua-driver 0.28.2+mako.29"), false)
assert.equal(driverProves("cua-driver 0.28.2+mako.24"), false)
assert.equal(driverProves("cua-driver 0.28.2"), false, "upstream's own build has no handshake")
assert.equal(driverProves(""), false)

// Through the host's own start, on a Mac or Linux (Windows finds programs by another lookup, and its check runs the
// real driver): a stand-in `cua-driver` on PATH listens on the socket it is given and records its environment.
if (process.platform !== "win32") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mako-cua-env-")))
  const seen = join(root, "environment.json")
  const standIn = join(root, "cua-driver")
  await writeFile(
    standIn,
    `#!${process.execPath}
const { writeFileSync } = require("node:fs")
const { createServer } = require("node:net")
writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env))
createServer((connection) => connection.destroy()).listen(process.argv[process.argv.indexOf("--socket") + 1])
process.on("SIGTERM", () => process.exit(0))
`
  )
  await chmod(standIn, 0o755)
  const cua = new CuaEmbedded()
  try {
    const socket = await cua.ensure(join(root, "state"), "dev.mako.environment-test", {
      ...process.env,
      PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
      // A desktop to drive, so a Linux host starts the driver at all.
      ...(process.platform === "linux" && { DISPLAY: process.env.DISPLAY ?? ":99", XDG_SESSION_TYPE: "x11" }),
      CUA_DRIVER_RS_MCP_HTTP_PORT: "8123",
      CUA_DRIVER_ENVELOPE_HTTP_PORT: "8124",
      CUA_DRIVER_PERMISSION_MODE: "unrestricted",
      CUA_DRIVER_SESSION_POLICY_FILE: join(root, "policy.json"),
      CUA_TELEMETRY_ENABLED: "1",
    })
    if (socket === null) console.log("cua embedded environment: no desktop here to start a driver for; the live half is skipped")
    else {
      const environment = Environment.parse(JSON.parse(await readFile(seen, "utf8")))
      const driver = Object.keys(environment).filter((name) => /^CUA_/i.test(name)).sort()
      for (const name of ["CUA_DRIVER_RS_MCP_HTTP_PORT", "CUA_DRIVER_ENVELOPE_HTTP_PORT", "CUA_DRIVER_SESSION_POLICY_FILE", "CUA_TELEMETRY_ENABLED"])
        assert.ok(!driver.includes(name), `${name} reached the daemon`)
      assert.equal(environment.CUA_DRIVER_PERMISSION_MODE, "standard", "the host's own setting is what the daemon has")
      assert.equal(environment.CUA_DRIVER_EMBEDDED, "1")
      assert.equal(environment.CUA_DRIVER_RS_TELEMETRY_ENABLED, "0")
      // And no key: the handshake is Windows' alone, so a Mac's or Linux machine's driver is never asked to prove itself.
      assert.equal(environment.CUA_DRIVER_EMBEDDED_HOST_KEY, undefined)
      const hosts = new Set(["CUA_DRIVER_EMBEDDED", "CUA_DRIVER_HOST_BUNDLE_ID", "CUA_DRIVER_PERMISSION_MODE", "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_REQUIRE_FOCUSED_TARGET", "CUA_DRIVER_RS_ENABLE_WAYLAND"])
      assert.deepEqual(driver.filter((name) => !hosts.has(name)), [], "only what the host sets itself")
    }
  } finally {
    cua.stop()
    await rm(root, { recursive: true, force: true })
  }
}
console.log("cua embedded environment: inherited driver settings are dropped; the daemon starts with the host's own only")
