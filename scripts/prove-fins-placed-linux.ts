import { execFile, spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs, promisify } from "node:util"
import type { JsonValue } from "@mako/host/contracts/json"

/**
 * A Fin placed on a Linux machine, live against a deployed cloud, from a checkout: builds the Linux device image from
 * this checkout's commit, then runs `prove-fins-placed.ts` with a container of it as the second device. The first
 * device, where the Apex runs, is a `mako-host` of the same build on this computer. What is proved, and what the
 * report holds, is in that script's header; this one adds the build, and removes what it built.
 *
 * It needs:
 * - Docker, or OrbStack, running and able to run `linux/amd64` (emulated on Apple silicon);
 * - this checkout installed (`npm ci`), and OpenCode installed on this computer, for the first device;
 * - an account on that cloud to confirm two device codes on.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/prove-fins-placed-linux.ts --cloud https://… --out <folder> \
 *     [--account cloud|free] [--relay-port 20721] [--keep-image]
 *
 * The codes: it prints `JOIN {"device","url","code"}` twice, first for this computer's host and then for the
 * container. Open each page signed in to the account the proof should run on and approve, within ten minutes, or have
 * whatever started this read the lines and confirm them. Nothing here signs in for anyone or holds a credential.
 *
 * The approvals: near the end it prints `ASK {"device","thread","name","title","question","decision"}` twice, the
 * first to allow and the second to reject, and reads the answer's effect on the container itself. A Fin on the container
 * asks to run a command, and the container has no window to allow it in. Open that Fin's Thread from the account's
 * list, on the web or another device signed in to the account, and allow it, within ten minutes.
 *
 * `--account` names the kind of account those codes are confirmed on, and the run fails if the devices joined
 * another kind. `cloud`, the default, is an account with the cloud: the case that works wherever placement does.
 * `free` is an account without it: it passes only against a cloud that gives every account the device network, and
 * elsewhere fails at the Fin's start, with the second device said to be offline.
 *
 * What it builds: the `device` stage of `runtime/host/Dockerfile`, for `linux/amd64`, as `mako-device-proof:<commit>`,
 * from the context `scripts/linux-host/prepare.mjs` writes of this checkout after `npm run build:control-runtime`:
 * its packages as built, and the media tools' pinned source archives, downloaded once into the checkout. `BUILD` and
 * `LINUX` name the commit; uncommitted changes to tracked files go into the image too, and both then say `dirty`.
 *
 * What it leaves: the report and both hosts' logs in `--out`. It removes the container and its volume, the image
 * (unless `--keep-image`), the build context and the scratch homes; both devices leave the account. Docker is left
 * running, and its build cache is kept.
 *
 * How long: three to five minutes on a machine that built the image before (a minute to build from cached layers,
 * two to four to run, most of it the container's host and its first Fin starting under emulation), plus however long
 * the codes and the approval wait for their person. The first build on a machine takes longer, since no layer is
 * cached and the image's media tools are compiled from source.
 *
 * It prints `BUILD …` lines, then the proof's own `JOIN`, `STEP`, `ASK` and `DONE` lines, then `LINUX {"ok",…}`.
 */
const { values } = parseArgs({
  options: {
    cloud: { type: "string" },
    out: { type: "string" },
    account: { type: "string", default: "cloud" },
    "relay-port": { type: "string", default: "20721" },
    "keep-image": { type: "boolean", default: false },
  },
})
if (!values.cloud || !values.out) throw new Error("--cloud and --out are required")
if (values.account !== "cloud" && values.account !== "free") throw new Error("--account is cloud or free")
const { cloud, account } = values
const out = resolve(values.out)
const run = promisify(execFile)
const say = (word: string, value: JsonValue) => console.log(`${word} ${JSON.stringify(value)}`)

/** A command of the build or the proof, its output this process's own; resolves with how it exited. */
function exec(command: string, args: string[]): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] })
    child.once("error", fail)
    child.once("exit", (code) => done(code ?? 1))
  })
}

async function built(what: string, command: string, args: string[]): Promise<void> {
  const began = performance.now()
  const code = await exec(command, args)
  say("BUILD", { step: what, ok: code === 0, ms: Math.round(performance.now() - began) })
  if (code !== 0) throw new Error(`${what} failed (${command} ended ${code})`)
}

const docker = await run("docker", ["info", "--format", "{{.ServerVersion}}"]).then(({ stdout }) => stdout.trim(), () => undefined)
if (!docker) throw new Error("Docker isn't running: start Docker or OrbStack, then run this again")
const commit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim()
const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=no"])).stdout.trim() !== ""
const image = `mako-device-proof:${commit.slice(0, 12)}`
const scratch = await mkdtemp(join(tmpdir(), "mako-fins-placed-linux-"))
const began = performance.now()
let ok = false
let buildMs = 0
try {
  say("BUILD", { step: "start", docker, commit, dirty, image })
  await built("the host and its packages", "npm", ["run", "-s", "build:control-runtime"])
  await built("the image's context", process.execPath, ["scripts/linux-host/prepare.mjs", "--output", join(scratch, "context")])
  await built("the device image", "docker", ["build", "--quiet", "--platform", "linux/amd64", "-f", "runtime/host/Dockerfile", "--target", "device", "-t", image, join(scratch, "context")])
  buildMs = Math.round(performance.now() - began)
  ok = (await exec("npx", ["tsx", "--tsconfig", "tsconfig.scripts.json", "scripts/prove-fins-placed.ts", "--root", join(scratch, "root"), "--out", out, "--cloud", cloud, "--relay-port", values["relay-port"], "--image", image, "--account", account])) === 0
} finally {
  if (!values["keep-image"]) await run("docker", ["rmi", image]).catch(() => undefined)
  await rm(scratch, { recursive: true, force: true })
  say("LINUX", { ok, image, commit, dirty, account, buildMs, ms: Math.round(performance.now() - began), report: join(out, "report.json"), ...(values["keep-image"] && { kept: image }) })
}
process.exit(ok ? 0 : 1)
