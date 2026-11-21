// A driver from before the proof handshake, for `prove-computer-use.mjs --older-driver`: Mako's real driver
// (MAKO_PROOF_REAL_DRIVER) behind a `cua-driver.cmd`, saying an older release for `--version` (`+mako.30`, the last
// that can't prove itself), and otherwise run as it was asked with this process's own stdin, stdout and stderr. The
// host then starts it without a key, as it starts the driver an installed app carried before it updated.
import { execFileSync, spawn } from "node:child_process"

const real = process.env.MAKO_PROOF_REAL_DRIVER
const args = process.argv.slice(2)
if (!real) {
  process.stderr.write("MAKO_PROOF_REAL_DRIVER names the real driver\n")
  process.exit(2)
}
if (args.includes("--version")) {
  const said = execFileSync(real, ["--version"], { encoding: "utf8", windowsHide: true })
  process.stdout.write(said.replace(/\+mako\.\d+/, "+mako.30"))
  process.exit(0)
}
const child = spawn(real, args, { stdio: "inherit", windowsHide: true })
child.once("exit", (code) => process.exit(code ?? 1))
child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(127)
})
