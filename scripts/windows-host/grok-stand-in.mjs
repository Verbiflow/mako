// Grok's CLI as the Windows proof's `grok.cmd` runs it: `--version` says MAKO_PROOF_GROK_VERSION, `agent … stdio` serves the streaming ACP stand-in
// (`scripts/fixtures/acp-stream-agent.mjs`) after starting a grandchild that only waits, whose pid it writes to
// MAKO_PROOF_GRANDCHILD_FILE, so the proof can see the whole tree end when the host ends the harness.
import { spawn, spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const args = process.argv.slice(2)
if (args.includes("--version")) {
  process.stdout.write(`grok ${process.env.MAKO_PROOF_GROK_VERSION} (windows stand-in)\n`)
  process.exit(0)
}
if (!args.includes("stdio")) {
  process.stderr.write(`The Windows stand-in for grok answers --version and agent stdio, not: ${args.join(" ")}\n`)
  process.exit(2)
}
// The task's Local Control, as an agent's shell reaches it: `mako-control` on PATH (a .cmd), the session's pipe and
// its proof from the session file. What it says goes where the proof reads it.
if (process.env.MAKO_PROOF_CONTROL_FILE) {
  const status = spawnSync("mako-control status", { shell: true, encoding: "utf8", timeout: 60_000 })
  writeFileSync(process.env.MAKO_PROOF_CONTROL_FILE, JSON.stringify({ code: status.status, stdout: status.stdout, stderr: status.stderr, sessionFile: process.env.MAKO_CONTROL_SESSION_FILE ?? null }))
}
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true })
if (process.env.MAKO_PROOF_GRANDCHILD_FILE) writeFileSync(process.env.MAKO_PROOF_GRANDCHILD_FILE, String(grandchild.pid))
await import(pathToFileURL(join(import.meta.dirname, "..", "fixtures", "acp-stream-agent.mjs")).href)
