import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { othersRunning, startHost, until } from "./host-process.mjs"

/**
 * The image's harnesses, installed as Mako's Settings installs them: a host
 * reads each harness's runtime, and every one it can't find but has an
 * install plan for goes through `mako:harness-install`, the vendor's own
 * installer or npm into this user's home. Nothing here names a harness or a
 * command; a definition that can't install on Linux fails the image's build.
 *
 *   node install-harnesses.mjs <record.json>
 */
const record = process.argv[2]
assert.ok(record, "Pass where to record what was installed")
// The image holds the harnesses, not the Mako state installing them leaves
// in this home, so the proof's host starts as on a fresh machine.
const makoHome = join(homedir(), ".mako")
assert.ok(!existsSync(makoHome), `${makoHome} exists: this prepares a fresh home, never one Mako has used`)
const scratch = await mkdtemp(join(tmpdir(), "mako-install-"))
const host = await startHost({ dataRoot: join(scratch, "data"), output: join(scratch, "host-output.log") })
try {
  const providers = (await host.call("mako:harness-descriptors")).map((harness) => harness.provider)
  // The first read starts a check of every runtime and answers what it holds so far.
  const before = await until(() => host.call("mako:harness-updates"), (updates) => providers.every((provider) => updates[provider]?.checkedAt), "every harness's runtime read")
  const installed = {}
  for (const provider of providers) {
    const reading = before[provider]
    if (reading.binary) {
      installed[provider] = { binary: reading.binary, version: reading.installed, how: "already present" }
      continue
    }
    assert.ok(reading.install, `${provider} isn't installed and has no install plan Mako can run here${reading.error ? `: ${reading.error}` : ""}`)
    const began = performance.now()
    const after = await host.call("mako:harness-install", provider)
    assert.equal(after.result?.outcome, "installed", `${provider} didn't install: ${after.result?.message ?? JSON.stringify(after)}`)
    installed[provider] = { binary: after.binary, version: after.installed, how: [reading.install.command, ...reading.install.args].join(" "), ms: Math.round(performance.now() - began) }
    console.log(`${provider} ${after.installed} at ${after.binary}, in ${installed[provider].ms} ms`)
  }
  // The same host, as Settings would see it right after installing.
  const live = new Set((await host.call("mako:harness-descriptors")).filter((harness) => harness.live).map((harness) => harness.provider))
  assert.deepEqual(providers.filter((provider) => !live.has(provider)), [], "Every harness can start a conversation once installed")
  await writeFile(record, `${JSON.stringify(installed, null, 2)}\n`)
} finally {
  await host.stop()
  await rm(scratch, { recursive: true, force: true })
}
// Its shared daemons leave on their own, and must before their state goes.
await until(othersRunning, (rows) => rows.length === 0, "the host's daemons leaving", 30_000)
await rm(makoHome, { recursive: true, force: true })
