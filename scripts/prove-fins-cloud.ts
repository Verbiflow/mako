import "./lib/scratch-git.mjs"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { DatabaseSync } from "node:sqlite"
import { parseArgs, promisify } from "node:util"
import { z } from "zod"
import { holdHostLease } from "@mako/host/base/host-idle"
import { invokeRuntime, runtimeInfo } from "@mako/host/transport/connection"
import type { RuntimeValue } from "@mako/host/contracts/runtime"
import { hostCommand, runtimeLocation } from "@mako/host/transport/service"
import { assertOwnHarnessStores } from "./lib/proof-host.ts"
import { assertScratchEnvironment, hostSafeStorage, scratchInstall, scratchKeychain, seedScratchHome } from "./scratch-harness-home.ts"
import { scriptedModel } from "./scripted-model.ts"

/**
 * A Fin placed in the cloud, from a real Apex on a host of this checkout: the Apex's half of the proof that opens
 * `place: cloud`. Its host is isolated (a data root of its own outside the application-data folder, in a scratch home
 * with no sign-in of the person's) and started with `MAKO_CLOUD_FIN_PROOF=open`, the one way a host gets
 * `AgentsDeps.cloudFins`; a cloud whose starts are closed refuses each start anyway. Its Apex is a Thread on OpenCode
 * in a clone of `--repository`, answered by a scripted model on this computer, whose committed, pushed source each
 * cloud Fin starts from.
 *
 * A driver runs it and reads the account, the machine and the money itself; this script says only what the Apex's
 * device holds, a line at a time on stdout, and does what each line on stdin asks:
 * - (at start) `SIGN IN <url>` for the driver to finish, then `READY {gateway, dataRoot, project, commit, apex}`.
 * - `start <json>`: `agents_start` from the Apex with that input. `STARTED <answer>`.
 * - `list`, `read <fin>`, `stop <fin>`: the Apex's `agents_list`, `agents_read`, `agents_stop`. `LISTED`, `READ`, `STOPPED`.
 * - `placings`: the Apex's device's `agent_placings` rows, read from its store, each record as its JSON text. `PLACINGS [...]`.
 * - `edges`: its Fins' edges (`thread_parents`), each record, placed or not, as its JSON text. `EDGES [...]`.
 * - `digests`: the Apex's requests that carried its Fins' news, with their notices. `DIGESTS [...]`.
 * - `log <pattern>`: the host log's lines matching it. `LOG [...]`.
 * - `restart`: the host stopped and started again on the same data root, signed in as it was. `RESTARTED {ms}`.
 * - `dirty` / `clean`: an uncommitted file in the project, or none. `DIRTY`, `CLEAN`.
 * - `quit`: everything stopped and signed out; the scratch home goes unless `--keep`.
 *
 * It runs against a staging gateway only, fenced twice before anything is made: `--cloud` must be one of the exact
 * origins the driver names in `MAKO_PROOF_CLOUDS` (comma-separated, from its own configuration, so no deployment's
 * name is written here), and that gateway's own `/health` must say it's `staging`. The host fences itself too: it
 * refuses `MAKO_CLOUD_FIN_PROOF` with no `MAKO_CLOUD_URL`, or with the one its build was stamped with.
 * However the run ends (`quit`, a failure, before or after the host started, or SIGINT, SIGTERM or SIGHUP) it ends
 * through one path, once: the account signed out (best effort, bounded), the host stopped (SIGTERM to its process
 * group, then SIGKILL after `HOST_STOP_MS`), the model closed and the scratch home gone, so nothing stays enrolled.
 *
 *   MAKO_PROOF_CLOUDS=<staging origin> npx tsx --tsconfig tsconfig.scripts.json scripts/prove-fins-cloud.ts --root <empty folder> --cloud <staging origin>
 *     [--repository https://github.com/octocat/Hello-World] [--opencode <version>] [--keep]
 */
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    cloud: { type: "string" },
    repository: { type: "string", default: "https://github.com/octocat/Hello-World" },
    opencode: { type: "string" },
    keep: { type: "boolean", default: false },
  },
})
if (!values.root || !values.cloud) throw new Error("--root and --cloud are required")
const root = values.root
const cloud = new URL(values.cloud)
if (cloud.protocol !== "https:") throw new Error("--cloud is a deployed gateway, on https")
// The first fence: an exact origin the driver named, never a pattern.
const allowed = (process.env.MAKO_PROOF_CLOUDS ?? "").split(",").map((each) => each.trim()).filter(Boolean)
if (!allowed.includes(cloud.origin)) throw new Error(`${cloud.origin} isn't one of the gateways MAKO_PROOF_CLOUDS names (${allowed.join(", ") || "none"}): this proof runs on staging alone`)
// The second: the gateway's own word on which deployment it is.
const Health = z.object({ env: z.string() }).loose()
const deployment = Health.parse(await (await fetch(new URL("/health", cloud.origin))).json())
if (deployment.env !== "staging") throw new Error(`${cloud.origin} says it's ${deployment.env}, not staging: this proof runs on staging alone`)
if ((await readdir(root).catch(() => [])).length) throw new Error(`${root} isn't empty: give the proof a folder of its own`)
const run = promisify(execFile)
/** A line for the driver: a word, then what it says as JSON. */
const say = (word: string, said?: RuntimeValue) => console.log(said === undefined ? word : `${word} ${JSON.stringify(said)}`)
/** How long a host has after SIGTERM before its process group is killed. */
const HOST_STOP_MS = 30_000
/** How long the account's sign-out may take as the run ends; past it the run ends anyway, saying so. */
const SIGN_OUT_MS = 10_000

// A home of its own with no sign-in of the person's: the Apex's OpenCode answers from the scripted model.
const scratch = seedScratchHome(root, {}, { keep: values.keep })
let model: Awaited<ReturnType<typeof scriptedModel>> | undefined
let host: ChildProcess | undefined
let release: (() => Promise<void>) | undefined
let signedInOnce = false
const dataRoot = join(root, "host")
const socket = runtimeLocation(dataRoot).socket
const client = randomUUID()
const call = (channel: string, args: unknown[]) => invokeRuntime(socket, client, channel, args)

/** Its process group's members, if any is still there. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}
/** The host stopped: SIGTERM to its process group, then SIGKILL once `HOST_STOP_MS` has passed, its lease let go. */
async function stopHost(): Promise<void> {
  const running = host
  host = undefined
  if (running?.pid !== undefined && groupAlive(running.pid)) {
    process.kill(-running.pid, "SIGTERM")
    for (const deadline = Date.now() + HOST_STOP_MS; groupAlive(running.pid) && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 200))
    if (groupAlive(running.pid)) {
      console.error(`the host's process group was still there ${HOST_STOP_MS / 1000} s after SIGTERM; killed`)
      process.kill(-running.pid, "SIGKILL")
    }
  }
  await release?.()
  release = undefined
}
let ending: Promise<void> | undefined
/** The one way the run ends, once, whatever ended it: signed out, the host stopped, the model closed, the home gone. */
function end(): Promise<void> {
  ending ??= (async () => {
    if (host && signedInOnce) {
      const out = await Promise.race([call("mako:cloud-sign-out", []).then(() => "signed out", (error: Error) => `sign-out failed: ${error.message}`), new Promise<string>((resolve) => setTimeout(() => resolve(`sign-out didn't answer within ${SIGN_OUT_MS / 1000} s`), SIGN_OUT_MS).unref())])
      if (out !== "signed out") console.error(`${out}; the device is ended with the account when the driver ends it`)
    }
    await stopHost().catch((error: Error) => console.error(`the host couldn't be stopped: ${error.message}`))
    await model?.close().catch(() => undefined)
    scratch.dispose()
    // The host's data root holds its sign-in and the Apex's store, and the home what the host's children wrote into it:
    // both go with the run unless it's kept.
    if (!values.keep) for (const folder of [dataRoot, scratch.home]) await rm(folder, { recursive: true, force: true }).catch((error: Error) => console.error(`${folder} couldn't be removed: ${error.message}`))
  })()
  return ending
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) process.once(signal, () => void end().finally(() => process.exit(code)))

try {
  scratchKeychain(scratch.home)
  const home = scratch.home
  const APEX_WORD = "APEX"
  model = await scriptedModel({
    reply: (text) => ({ text: [...text.matchAll(/Reply with the single word ([A-Za-z0-9-]+)\./g)].at(-1)?.[1] ?? "OK" }),
    aside: "Cloud Fins proof",
  })
  await mkdir(join(home, ".config", "opencode"), { recursive: true })
  await writeFile(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", enabled_providers: ["anthropic"], provider: { anthropic: { options: { baseURL: `${model.url}/v1`, apiKey: "cloud-fins-proof" } } } }, null, 2))

  // The project: a clone of the repository at its default branch's tip, committed and pushed as it stands.
  const project = join(home, "projects", new URL(values.repository).pathname.split("/").at(-1) ?? "project")
  await mkdir(join(home, "projects"), { recursive: true })
  await run("git", ["clone", "-q", values.repository, project], { env: scratch.env })
  const commit = (await run("git", ["-C", project, "rev-parse", "HEAD"])).stdout.trim()
  const DIRTY_FILE = "cloud-fins-proof-uncommitted.md"

  const opencodeBin = values.opencode ? join(root, "opencode", "bin") : undefined
  if (opencodeBin) {
    await scratchInstall("npm", ["install", "-g", "--prefix", join(root, "opencode"), "--allow-scripts=@opencode/cli", `@opencode/cli@${values.opencode}`], { env: { ...scratch.env } })
    const installed = (await run(join(opencodeBin, "opencode"), ["--version"], { env: { ...scratch.env } })).stdout.trim()
    if (/\d+\.\d+\.\d+\S*/.exec(installed)?.[0] !== values.opencode) throw new Error(`npm installed OpenCode ${installed}, not ${values.opencode}`)
  }

  // The host: screenless, its data root its own outside the application-data folder, so it's isolated, and only then
  // may it open cloud Fins (`HostConfig.cloudFinProof`).
  const hostEnv: NodeJS.ProcessEnv = {
    ...scratch.env,
    ...(opencodeBin && { PATH: [opencodeBin, scratch.env["PATH"]].filter(Boolean).join(delimiter) }),
    MAKO_CLOUD_URL: cloud.origin,
    MAKO_SCREENLESS: "1",
    MAKO_CLOUD_FIN_PROOF: "open",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  }
  assertScratchEnvironment(hostEnv, "the cloud Fins proof's host")
  // SAFETY: the electron package's main export is the path of its executable.
  const electron = createRequire(import.meta.url)("electron") as string
  const command = hostCommand({ executable: electron, args: [process.cwd()], env: { ...hostEnv, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: socket } })
  // A host in Node mode reads its data key from the scratch keychain but never makes it: without this it keeps no secret.
  hostSafeStorage(home, command.executable, process.cwd())
  /** The host in a process group of its own, so its stop reaches every process it started. */
  const startHost = async (): Promise<void> => {
    host = spawn(command.executable, command.args, { env: command.env, stdio: "ignore", detached: true })
    for (const deadline = Date.now() + 60_000; !(await runtimeInfo(socket).catch(() => null)); await new Promise((resolve) => setTimeout(resolve, 250))) {
      if (Date.now() > deadline) throw new Error(`the host didn't start within a minute; its log is ${join(dataRoot, "logs", "host.log")}`)
    }
    release = await holdHostLease(runtimeLocation(dataRoot).directory)
  }
  await startHost()
  await assertOwnHarnessStores(call, dataRoot)

  const AccountSchema = z.object({ state: z.object({ status: z.string(), url: z.string().optional(), account: z.object({ entitlements: z.array(z.string()) }).loose().optional() }).loose() }).loose()
  async function signedIn(ms: number): Promise<void> {
    let account = AccountSchema.parse(await call("mako:cloud-account", []))
    for (const deadline = Date.now() + ms; !(account.state.status === "signed-in" && account.state.account?.entitlements.includes("cloud")); ) {
      if (Date.now() > deadline) throw new Error(`the host isn't signed in with the cloud: ${account.state.status}`)
      await new Promise((resolve) => setTimeout(resolve, 500))
      account = AccountSchema.parse(await call("mako:cloud-account", []))
    }
  }
  signedInOnce = true
  const signing = AccountSchema.parse(await call("mako:cloud-sign-in", []))
  if (signing.state.status === "signing-in") console.log(`SIGN IN ${signing.state.url ?? ""}`)
  await signedIn(5 * 60_000)

  const SnapshotSchema = z.object({
    sessionId: z.string().optional(),
    threadId: z.string().optional(),
    requests: z.array(z.object({ id: z.string(), status: z.string(), text: z.string().optional(), digest: z.object({ notices: z.array(z.object({ id: z.string() }).loose()) }).loose().optional() }).loose()).default([]),
  }).loose()
  const snapshot = async (id: string) => SnapshotSchema.parse(await call("mako:live-snapshot", [id]))

  // The Apex: a Thread on OpenCode in the project, its first turn answered by the scripted model.
  const conversation = randomUUID()
  const first = randomUUID()
  await call("mako:live-start", ["opencode", project, { conversationId: conversation, title: "Cloud Fins proof", initialRequest: { id: first, text: `Reply with the single word ${APEX_WORD}.`, attachments: [] } }])
  for (const deadline = Date.now() + 5 * 60_000; ; await new Promise((resolve) => setTimeout(resolve, 500))) {
    const status = (await snapshot(conversation)).requests.find((request) => request.id === first)?.status
    if (status === "completed") break
    if (status === "failed" || Date.now() > deadline) throw new Error(`the Apex's first turn didn't complete: ${status ?? "never started"}`)
  }
  const apex = await snapshot(conversation)
  if (!apex.sessionId || !apex.threadId) throw new Error("the Apex's conversation has no Thread")
  const caller = { kind: "agent", session: apex.sessionId }
  say("READY", { gateway: cloud.origin, dataRoot, project, repository: values.repository, commit, apex: { conversation, session: apex.sessionId, thread: apex.threadId } })

  /** The Apex's device's store, read only: its placings and its Fins' edges as they stand. */
  function readStore<Row>(sql: string): Row[] {
    const store = new DatabaseSync(join(dataRoot, "threads.sqlite"), { readOnly: true })
    try {
      // SAFETY: each query names the columns its caller reads.
      return store.prepare(sql).all() as Row[]
    } finally {
      store.close()
    }
  }

  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    const [word, ...rest] = line.trim().split(" ")
    const argument = rest.join(" ")
    try {
      if (word === "quit") break
      else if (word === "start") say("STARTED", await call("mako:agents-start", [caller, JSON.parse(argument)]))
      else if (word === "list") say("LISTED", await call("mako:agents-list", [caller, {}]))
      else if (word === "read") say("READ", await call("mako:agents-read", [caller, { child: argument }]))
      else if (word === "stop") say("STOPPED", await call("mako:agents-stop", [caller, { child: argument, reason: "the proof stops it" }]))
      else if (word === "placings") say("PLACINGS", readStore<{ op: string; record: string; at: number }>("SELECT op, record, at FROM agent_placings"))
      else if (word === "edges") say("EDGES", readStore<{ child_thread: string; name: string; op: string; record: string; created_at: number; closed_at: number | null }>("SELECT child_thread, name, op, record, created_at, closed_at FROM thread_parents"))
      else if (word === "digests") say("DIGESTS", (await snapshot(conversation)).requests.filter((request) => request.digest).map(({ id, status, text, digest }) => ({ id, status, text: text?.slice(0, 2_000) ?? "", notices: digest?.notices.map((notice) => notice.id) ?? [] })))
      else if (word === "log") {
        const pattern = new RegExp(argument)
        say("LOG", (await readFile(join(dataRoot, "logs", "host.log"), "utf8")).split("\n").filter((each) => pattern.test(each)).slice(-200))
      } else if (word === "restart") {
        const began = Date.now()
        await stopHost()
        await startHost()
        await signedIn(60_000)
        say("RESTARTED", { ms: Date.now() - began })
      } else if (word === "dirty") {
        await writeFile(join(project, DIRTY_FILE), "not committed\n")
        say("DIRTY", { file: DIRTY_FILE })
      } else if (word === "clean") {
        await rm(join(project, DIRTY_FILE), { force: true })
        say("CLEAN")
      } else say("UNKNOWN", { line })
    } catch (error) {
      say("FAILED", { line, error: error instanceof Error ? error.message : String(error) })
    }
  }
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
} finally {
  await end()
}
say("ENDED")
