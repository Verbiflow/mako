// Proves every installed harness's `startPrefetch` against its real CLI: the process its start spawns, spawned the
// same way, reaches its first answer and is stopped, leaving nothing running. In a scratch home, so no harness reads or
// writes the person's own configuration, and without a sign-in, as a cloud machine runs it while it boots.
//
//   npm run build:electron && node scripts/prove-start-prefetch.mjs [harness …]
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { prefetchStart } from "@mako/host/harnesses/start-prefetch"

const asked = process.argv.slice(2)
const home = await mkdtemp(join(tmpdir(), "mako-start-prefetch-"))
const env = { ...process.env, HOME: home }
for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"]) delete env[name]
const host = createHarnessHost(detachedHarnessContext(new NativeStores(false)))
let failed = 0
try {
  for (const { provider } of host.harnesses.list()) {
    if (asked.length && !asked.includes(provider)) continue
    const driver = host.liveDrivers.get(provider)
    const prefetch = driver?.startPrefetch
    if (!driver?.available(process.cwd())) {
      console.log(`${provider.padEnd(9)} not installed here`)
      continue
    }
    if (prefetch?.kind !== "process") {
      console.log(`${provider.padEnd(9)} none: ${prefetch?.reason ?? "undeclared"}`)
      continue
    }
    const launch = await prefetch.launch({ ...env }, home)
    assert.ok(launch, `${provider} resolves what its start runs`)
    const outcome = await prefetchStart(launch, home, `prove:${provider}`)
    const again = await prefetchStart(launch, home, `prove:${provider}`)
    const ok = outcome.answered && again.answered
    if (!ok) failed += 1
    console.log(`${provider.padEnd(9)} ${ok ? "answered" : "DIDN'T ANSWER"}  first ${outcome.ms} ms, again ${again.ms} ms  ${launch.command.split("/").at(-1)} ${launch.args.join(" ").slice(0, 60)}`)
  }
  // Each process is stopped once it answers; after the stop's grace, nothing may still be at work in the scratch home.
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  const { spawnSync } = await import("node:child_process")
  const left = spawnSync("lsof", ["-t", "+D", home], { encoding: "utf8" }).stdout.trim()
  assert.equal(left, "", "every process run ahead is stopped")
} finally {
  await rm(home, { recursive: true, force: true })
}
assert.equal(failed, 0, `${failed} harness${failed === 1 ? "" : "es"} didn't answer`)
console.log("start prefetch: each harness's start, run ahead, answered and was stopped")
