// Grok's CLI as the Windows proof's `grok.cmd` runs it: `--version` says MAKO_PROOF_GROK_VERSION, `agent … stdio` serves the streaming ACP stand-in
// (`scripts/fixtures/acp-stream-agent.mjs`) after starting a grandchild that only waits, whose pid it writes to
// MAKO_PROOF_GRANDCHILD_FILE, so the proof can see the whole tree end when the host ends the harness.
import { spawn } from "node:child_process"
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
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true })
if (process.env.MAKO_PROOF_GRANDCHILD_FILE) writeFileSync(process.env.MAKO_PROOF_GRANDCHILD_FILE, String(grandchild.pid))
await import(pathToFileURL(join(import.meta.dirname, "..", "fixtures", "acp-stream-agent.mjs")).href)
