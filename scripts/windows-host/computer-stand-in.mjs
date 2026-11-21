// Grok's CLI as the Windows computer-use proof runs it (`prove-computer-use.mjs`): `--version` says
// MAKO_PROOF_GROK_VERSION, and `agent … stdio` first does what an agent given computer use does, with the control
// session Mako put in its environment (MAKO_CONTROL_SESSION_FILE): it runs MAKO_PROOF_COMPUTER_PROGRAM through the
// control CLI and writes what came back to MAKO_PROOF_COMPUTER_RESULT. Then it serves the streaming ACP stand-in, so
// the Thread's turn runs to its end.
import { execFile } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const args = process.argv.slice(2)
if (args.includes("--version")) {
  process.stdout.write(`grok ${process.env.MAKO_PROOF_GROK_VERSION} (windows stand-in)\n`)
  process.exit(0)
}
if (!args.includes("stdio")) {
  process.stderr.write(`The Windows stand-in for grok answers --version and agent stdio, not: ${args.join(" ")}\n`)
  process.exit(2)
}
const { MAKO_PROOF_COMPUTER_PROGRAM: program, MAKO_PROOF_COMPUTER_RESULT: result, MAKO_PROOF_CONTROL_CLI: cli, MAKO_CONTROL_SESSION_FILE: session } = process.env
if (program && result && cli) {
  const outcome = { session: session ?? null }
  if (!session) outcome.error = "Mako gave this harness no control session (MAKO_CONTROL_SESSION_FILE is unset)"
  else {
    try {
      // The launcher Mako wrote beside the session, as an agent's shell would run it (`mako-control.cmd`, through
      // ComSpec as any batch file); the CLI's own script where there is none.
      const launcher = join(dirname(dirname(session)), "mako-control.cmd")
      const options = { timeout: 90_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
      outcome.launcher = existsSync(launcher) ? launcher : null
      const { stdout, stderr } = existsSync(launcher) && process.env.ComSpec
        ? await promisify(execFile)(process.env.ComSpec, ["/d", "/s", "/c", `""${launcher}" exec --source-file "${program}""`], { ...options, windowsVerbatimArguments: true })
        : await promisify(execFile)(process.execPath, [cli, "exec", "--source-file", program], options)
      Object.assign(outcome, { stdout, stderr })
    } catch (error) {
      Object.assign(outcome, { error: error.message, stdout: error.stdout ?? "", stderr: error.stderr ?? "" })
    }
  }
  writeFileSync(result, JSON.stringify(outcome))
}
await import(pathToFileURL(join(import.meta.dirname, "..", "fixtures", "acp-stream-agent.mjs")).href)
