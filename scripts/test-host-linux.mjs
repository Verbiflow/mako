import { spawn } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

/**
 * Item 1.1's Linux proof, from a built checkout: the image of
 * runtime/host/Dockerfile from scripts/linux-host/prepare.mjs's context, its
 * harnesses installed by the host while it builds, then
 * scripts/linux-host/prove.mjs in a container of it, with the network a
 * machine has and no account. `npm run test:host-linux` builds first.
 * `--measure` then runs scripts/measure-host.mjs on the installed host in a
 * fresh container, for the Linux column of the host design's performance table.
 * The image is x64, emulated on another machine.
 *
 *   node scripts/test-host-linux.mjs [--evidence <dir>] [--measure]
 */
const { values } = parseArgs({ options: { evidence: { type: "string" }, measure: { type: "boolean", default: false } } })
const scratch = await mkdtemp(join(tmpdir(), "mako-host-linux-"))
const context = join(scratch, "context")
const evidence = resolve(values.evidence ?? join(scratch, "evidence"))
const platform = ["--platform", "linux/amd64"]
const image = "mako-host-linux:proof"

function step(command, args) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: "inherit" })
    child.once("error", fail)
    child.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)))
  })
}

if (await step(process.execPath, ["scripts/linux-host/prepare.mjs", `--output=${context}`])) process.exit(1)
await mkdir(evidence, { recursive: true })
// What the image was built from: the commit, whether it was dirty, every file's hash.
await copyFile(join(context, "manifest.json"), join(evidence, "manifest.json"))
const built = await step("docker", ["build", ...platform, "-f", "runtime/host/Dockerfile", "--target", "proof", "-t", image, context])
await rm(context, { recursive: true, force: true })
if (built) process.exit(1)
// The image's user writes the evidence.
await chmod(evidence, 0o777)
// Without a syscall filter, as on a machine's VM: Docker's default profile refuses the browser's sandbox its namespaces.
const code = await step("docker", ["run", "--rm", "--init", ...platform, "--security-opt", "seccomp=unconfined", "-v", `${evidence}:/evidence`, image])
const result = await readFile(join(evidence, "result.json"), "utf8").then(JSON.parse, () => undefined)
console.log(`\n${result ? `Linux proof ${result.status} on ${result.machine.arch}, Node ${result.machine.node}` : "The proof wrote no result"}; evidence in ${evidence}`)
const proved = code || (result?.status === "passed" ? 0 : 1)
const measured = values.measure && !proved
  ? await step("docker", ["run", "--rm", "--init", ...platform, "-v", `${evidence}:/evidence`, "-w", "/opt/mako/proof/measure", "--entrypoint", "node", image,
      "scripts/measure-host.mjs", "--program", "/opt/mako/packages/host/dist/mako-host.js", "--out", "/evidence/measure.json"])
  : 0
process.exitCode = proved || measured
