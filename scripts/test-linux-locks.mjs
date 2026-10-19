import { spawn } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

/**
 * The record store's locks (`packages/sessions/src/record-locks.ts`) on
 * real Linux, in Docker, from a built checkout (`npm run test:linux-locks`
 * builds `@mako/sessions` first). The checkout is mounted read-only, with
 * the `node_modules` its packages resolve to (a worktree's are links into
 * the main checkout's); nothing is installed. It runs:
 *
 * - the lock-touching tests: `record-locks.mjs` (one holder, a SIGKILLed
 *   holder frees at once, two data roots apart, the name abstract and
 *   listed by the kernel), `record-orphans.mjs` (captures and repacks killed
 *   in processes of their own), `record-backfill.mjs`, `record-repack.mjs`;
 * - with no /proc (a tmpfs mounted over it): the locks and the orphans;
 * - with no `AF_UNIX` (a seccomp profile refusing it): a lock is refused as
 *   `LockUnavailableError`, and owners are judged by their pid;
 * - two containers holding one store's lock through a shared folder: each
 *   has its own network namespace, so each takes it, while a third joined to
 *   the first's network namespace is refused.
 *
 *   node scripts/test-linux-locks.mjs [--image node:24-slim] [--platform linux/amd64]
 */

const { values } = parseArgs({ options: { image: { type: "string", default: "node:24-slim" }, platform: { type: "string" } } })
const checkout = resolve(".")
const modules = dirname(await realpath(join(checkout, "node_modules", "zod")))
const platform = values.platform ? ["--platform", values.platform] : []
const mounts = ["-v", `${checkout}:/work:ro`, "-v", `${modules}:/work/node_modules:ro`, "-w", "/work/packages/sessions"]
const scratch = await mkdtemp(join(tmpdir(), "mako-linux-locks-"))
const failures = []

function docker(args, { quiet = false } = {}) {
  return new Promise((done, fail) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "inherit"] })
    let out = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (text) => {
      out += text
      if (!quiet) process.stdout.write(text)
    })
    child.once("error", fail)
    child.once("exit", (code) => done({ code: code ?? 1, out }))
  })
}

async function step(name, args) {
  console.log(`\n== ${name}`)
  const { code } = await docker(["run", "--rm", ...platform, ...mounts, ...args])
  if (code) failures.push(name)
}

/** A program holding (or trying for) the lock of the store at /shared/store, run inside a container. */
const holder = (hold) => `
  const { takeLock } = await import("/work/packages/sessions/dist/record-locks.js")
  const lock = await takeLock("/shared/store/backfill.lock")
  console.log(lock ? "held" : "refused")
  ${hold ? "setInterval(() => {}, 1000)" : "process.exit(0)"}
`

try {
  await step("the lock-touching tests", [values.image, "sh", "-c", "node test/record-locks.mjs && node test/record-orphans.mjs && node test/record-backfill.mjs && node test/record-repack.mjs"])
  // Docker refuses to mount over /proc; a mount namespace of the container's own can.
  await step("no /proc", ["--cap-add", "SYS_ADMIN", "--security-opt", "apparmor=unconfined", values.image, "sh", "-c",
    "mount -t tmpfs none /proc && MAKO_LOCKS_WITHOUT=proc node test/record-locks.mjs && node test/record-orphans.mjs"])
  // socket(AF_UNIX, …) answers EAFNOSUPPORT, as a sandbox's policy can make it.
  const profile = join(scratch, "no-unix-sockets.json")
  await writeFile(profile, JSON.stringify({ defaultAction: "SCMP_ACT_ALLOW", syscalls: [{ names: ["socket"], action: "SCMP_ACT_ERRNO", errnoRet: 97, args: [{ index: 0, value: 1, op: "SCMP_CMP_EQ" }] }] }))
  await step("no AF_UNIX", ["--security-opt", `seccomp=${profile}`, "-e", "MAKO_LOCKS_WITHOUT=socket", values.image, "node", "test/record-locks.mjs"])

  console.log("\n== two containers, one store")
  // Made here, so it's this user's, not the container's root's; a lock on Linux writes nothing into it.
  const shared = join(scratch, "shared")
  await mkdir(shared)
  const name = `mako-linux-locks-${process.pid}`
  const started = await docker(["run", "-d", "--name", name, ...platform, ...mounts, "-v", `${shared}:/shared`, values.image, "node", "--input-type=module", "-e", holder(true)], { quiet: true })
  if (started.code) failures.push("the first container")
  try {
    // The first container says `held` once its lock is taken; its log is read until it does.
    const logs = spawn("docker", ["logs", "-f", name], { stdio: ["ignore", "pipe", "inherit"] })
    let first = ""
    logs.stdout.setEncoding("utf8")
    await new Promise((done) => {
      logs.stdout.on("data", (text) => {
        first += text
        if (/held|refused/.test(first)) done()
      })
      logs.once("exit", done)
    })
    logs.kill()
    const own = await docker(["run", "--rm", ...platform, ...mounts, "-v", `${shared}:/shared`, values.image, "node", "--input-type=module", "-e", holder(false)], { quiet: true })
    const joined = await docker(["run", "--rm", ...platform, ...mounts, "-v", `${shared}:/shared`, "--network", `container:${name}`, values.image, "node", "--input-type=module", "-e", holder(false)], { quiet: true })
    console.log(`first container: ${first.trim()}; a second, its own network namespace: ${own.out.trim()}; a third, in the first's: ${joined.out.trim()}`)
    if (first.trim() !== "held" || own.out.trim() !== "held" || joined.out.trim() !== "refused") failures.push("two containers, one store")
    else console.log("An abstract name is per network namespace: containers sharing a store through a mount don't exclude each other; one sharing the network does.")
  } finally {
    await docker(["rm", "-f", name], { quiet: true })
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`\nFailed on Linux: ${failures.join(", ")}`)
  process.exitCode = 1
} else console.log("\nThe record store's locks hold on Linux")
