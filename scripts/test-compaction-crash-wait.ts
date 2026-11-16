import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

/** The same real crash fixture, with delays before setup or after the parent's phase release. No provider is used. */
async function delayed(where: "BOOT" | "PHASE") {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.MAKO_COMPACTION_CRASH_BOOT_PAUSE_MS
  delete env.MAKO_COMPACTION_CRASH_PHASE_PAUSE_MS
  env[`MAKO_COMPACTION_CRASH_${where}_PAUSE_MS`] = "5500"
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./test-compaction-crash.ts", import.meta.url)), "--case=uncertain-off"], {
    env, stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject) })
  return { code, output }
}
const boot = await delayed("BOOT")
assert.equal(boot.code, 0, boot.output)
assert.match(boot.output, /PASS: actual process crash at uncertain-off/)
const phase = await delayed("PHASE")
assert.notEqual(phase.code, 0)
assert.match(phase.output, /child reaches durable uncertain-off boundary|durable uncertain-off checkpoint exceeded five seconds/)
assert.match(phase.output, /phase-started/)
assert.doesNotMatch(phase.output, /child prepares uncertain-off/)
console.log("PASS: slow bootstrap cannot consume the five-second crash boundary; an actual delayed phase still fails it")
