import { execFile, spawn } from "node:child_process"
import { createRequire } from "node:module"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { parseArgs } from "node:util"
import WebSocket from "ws"
import { z } from "zod"
import { invokeRuntime, runtimeInfo } from "@mako/host/transport/connection"
import { hostCommand, runtimeLocation } from "@mako/host/transport/service"
import { assertOwnHarnessStores, proofDataRoot } from "./lib/proof-host.ts"
import { hostSafeStorage, scratchHostHome } from "./scratch-harness-home.ts"
import { holdHostLease } from "@mako/host/base/host-idle"

/**
 * 4.4's live proof: a Thread of this Mac's own host moved to the cloud, on each harness, through the calls the window
 * makes. For each harness it:
 *
 * 1. starts a Thread in its own worktree of a public repository, and has the agent write a file there;
 * 2. adds a commit and a staged file of its own, so the move carries all three kinds of change;
 * 3. asks for a move while a turn runs, which must be refused with nothing moved, and the turn must still finish here;
 * 4. moves the Thread, asks again under the same move id (the same answer, nothing done twice), and reads each step's
 *    time from the move's plan;
 * 5. sends a turn that now runs on the cloud machine: the agent must say from memory what it wrote (the same native
 *    session), and its commands' own output must show the files, the commit and the Mac's path.
 *
 * With `--handoff <harness>`, a Thread of that harness is then handed off while its agent runs a long command: the
 * turn must pause here, go on and finish on the machine, and the file it wrote there come back with the Thread.
 *
 * Prints no secret; writes a JSON report. The Threads stay, on their cloud machines, to be looked at, and so does the
 * project their worktrees were made from, so any of them can come back: in the data root on a host of its own.
 *
 *   npx tsx scripts/prove-cloud-moves.ts --data-root <dir> (--spawn-host --cloud <url> | --scratch-host) [--harness claude …] [--report <file>]
 *
 * Only ever on a host of its own, never this Mac's own Mako: a proof's Threads, sessions and worktrees would be the
 * person's. `--data-root <dir>` names that host's data root; with `--spawn-host` the run starts it there from this
 * checkout's build, screenless, its cloud `--cloud <url>`, for an end-to-end run beside a local cloud; with
 * `--scratch-host` it's one already running (a packaged app's, started by `PackagedApp`). Either way its harnesses run in
 * a home of its own (`scratchHostHome`): their sessions land there, never in the person's `~/.claude` and the like,
 * which the person's Mako lists. The run checks it before anything else: the host's catalog may list nothing from the
 * person's harness stores. A host that isn't signed in is asked to sign in, and the page it waits on
 * is printed on a line of its own (`SIGN IN <url>`) for whoever plays the person; the run goes on once the account is
 * signed in with the cloud.
 *
 * A host of its own shares each harness's sign-in with its cloud as access alone (`accessOnly`): its machines run the
 * harnesses signed in as this Mac is, and the throwaway cloud is never given a refresh token, so nothing there can
 * rotate the sign-in this Mac and Mako Cloud hold. Step 5 reads the machine's side from the conversation's history as
 * the machine serves it (the session's records arrived and its native session resumed there). Then it opens a new tab
 * in the cloud Thread and forks it, each a turn on the machine (`--tab-harness`), brings the Thread back, and has the
 * moved conversation, the tab and the fork each recall here what it said, in the same native sessions.
 */
const { values } = parseArgs({
  options: {
    harness: { type: "string", multiple: true },
    repository: { type: "string", default: "https://github.com/octocat/Hello-World" },
    report: { type: "string" },
    "data-root": { type: "string" },
    "spawn-host": { type: "boolean", default: false },
    /**
     * The host at `--data-root` is a scratch one already running (a packaged app's, started on a profile of its own):
     * its own-host steps run, and it stays signed in when the run ends, for whoever drives it next.
     */
    "scratch-host": { type: "boolean", default: false },
    cloud: { type: "string" },
    /**
     * On a host of its own: the harness of the new tab and the fork begun in the cloud, each running a turn on the
     * machine. The Thread's own by default.
     */
    "tab-harness": { type: "string" },
    /**
     * At the end, the cloud's machine places, filled: that many cloud conversations are started (OpenCode, which runs
     * unsigned), then a move of a Thread back here must be refused at once, saying the cloud is full, never queued.
     */
    "full-cloud": { type: "string" },
    /**
     * At the end, a Thread of this harness handed off mid-turn (rule 2 of moves): its agent runs a long command, the
     * move pauses the turn, and the turn must go on and finish on the machine; then it comes back with what it wrote.
     */
    handoff: { type: "string" },
    /**
     * Seconds the handoff's Thread works before it's handed off, once kept ready: long enough (a machine's grace and its
     * boot) and the cloud Thread standing by has started, warmed and paused, as it has by the time a lid closes.
     */
    "handoff-wait": { type: "string" },
    /**
     * What hands the Thread off: `asked` (the move's own call, by default), `quit` (the person quits the app: Cmd+Q in
     * its window, then "Hand off to the cloud and quit" in the sheet, through `--devtools`, the window's DevTools page
     * socket), or `sleep` (the person closes the lid; the run says when, and waits for the handoff the sleep makes).
     */
    "handoff-by": { type: "string", default: "asked" },
    /**
     * A Thread of its own, moved to the cloud with a tab begun there, whose tab is then forked this many times on its
     * machine, each fork checked to be in a Session of its own (the Mac and the machine naming it alike). Left in the
     * cloud, so turnless forks never ride a way back.
     */
    "fork-burst": { type: "string" },
    /**
     * This many Threads, each moved onto a machine of its own, whose agent runs a fresh process printing a random UUID
     * and the kernel's view of the machine: no two machines cloned from one image may draw the same randomness.
     */
    entropy: { type: "string" },
    devtools: { type: "string" },
    /**
     * A Thread of this harness in a project whose recipe carries `.env` (a dummy value) and whose app reads it: copied
     * to the account's store with the person's word, its app started on the machine reads it; back here it's
     * unchanged; changed here, the next move's app reads the new one; removed from the cloud, the next start says the
     * named secret is missing. The values are written to `carried-values.txt` beside the report, for grepping logs.
     */
    carried: { type: "string" },
    /**
     * A Thread of this harness in a project of its own, moved to the cloud, whose project is then moved away on this
     * Mac: the way back must be refused before the cloud is asked anything, naming the project, the Thread going on in
     * the cloud (a turn runs there); then, brought back with the folder the project moved to, it comes back into its
     * worktree at the same folder, with what it wrote.
     */
    "project-gone": { type: "string" },
    /**
     * A Thread of this harness moved to the cloud, a turn run there, then archived from this Mac as the sidebar does:
     * the cloud ends it (its machine packs and goes), a call to it is refused, asked again nothing is done twice, and
     * restored it comes back here with what it wrote in the cloud. Prints `ARCHIVED <cloud Thread>` and `RESTORED
     * <cloud Thread>` as each lands, for a second device to watch the account's list say so.
     */
    archive: { type: "string" },
  },
})
// With `--handoff` or `--fork-burst` alone, only that runs.
const HARNESSES = values.harness?.length ? values.harness : values.handoff || values["fork-burst"] || values.entropy || values.carried || values["project-gone"] || values.archive ? [] : ["claude", "codex", "cursor", "opencode", "grok", "devin"]
const dataRoot = proofDataRoot(values["data-root"], "the moves proof")
if (!values["spawn-host"] && !values["scratch-host"]) throw new Error("the moves proof needs --spawn-host or --scratch-host: a host of its own")
const { socket } = runtimeLocation(dataRoot)
const client = randomUUID()
const call = (channel: string, args: unknown[]) => invokeRuntime(socket, client, channel, args)
const run = promisify(execFile)

// A host of its own, when asked: screenless, so its sign-in opens nothing on this Mac, sharing sign-ins as access alone,
// held up by this run's lease (a profile host stops once nothing holds it) and stopped when the run ends. It runs in a
// scratch home in its data root, kept with it, so a Thread left in the cloud comes back into the same harness stores.
if (values["spawn-host"]) {
  if (!values.cloud) throw new Error("--spawn-host needs --cloud")
  await mkdir(join(dataRoot, "cloud"), { recursive: true, mode: 0o700 })
  await writeFile(join(dataRoot, "cloud", "sign-ins.json"), JSON.stringify({ version: 2, sharing: true, accessOnly: true, inStep: {} }), { mode: 0o600 })
  // As `ensureRuntime` starts one: this checkout's build, under Electron's Helper in Node mode.
  // SAFETY: the electron package's main export is the path of its executable.
  const electron = createRequire(import.meta.url)("electron") as string
  // Kept with the data root: its sign-ins and keychain go as the run ends, its sessions stay for the Threads left in the cloud.
  const { env, home } = scratchHostHome(dataRoot, { keep: true })
  const command = hostCommand({ executable: electron, args: [process.cwd()], env: { ...env, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: socket, MAKO_CLOUD_URL: values.cloud, MAKO_SCREENLESS: "1" } })
  // Its keychain's safe-storage item, made by its own binary: without it, it could keep no cloud sign-in.
  hostSafeStorage(home, command.executable, process.cwd())
  const host = spawn(command.executable, command.args, { env: command.env, stdio: "ignore" })
  process.once("exit", () => host.kill("SIGTERM"))
  for (const deadline = Date.now() + 60_000; !(await runtimeInfo(socket).catch(() => null)); ) {
    if (Date.now() > deadline) throw new Error(`the host at ${dataRoot} didn't start within a minute; its log is in ${join(dataRoot, "logs", "host.log")}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const release = await holdHostLease(runtimeLocation(dataRoot).directory)
  process.once("beforeExit", () => void release())
}

await assertOwnHarnessStores(call, dataRoot)

// Signed in, with the cloud: asked for once if not, the page printed for whoever plays the person.
const AccountSchema = z.object({ state: z.object({ status: z.string(), url: z.string().optional(), account: z.object({ entitlements: z.array(z.string()) }).loose().optional() }).loose() }).loose()
let account = AccountSchema.parse(await call("mako:cloud-account", []))
if (account.state.status !== "signed-in") {
  account = AccountSchema.parse(await call("mako:cloud-sign-in", []))
  if (account.state.status === "signing-in") console.log(`SIGN IN ${account.state.url ?? ""}`)
}
for (const deadline = Date.now() + 10 * 60_000; !(account.state.status === "signed-in" && account.state.account?.entitlements.includes("cloud")); ) {
  if (Date.now() > deadline) throw new Error(`the host isn't signed in with the cloud: ${account.state.status}`)
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  account = AccountSchema.parse(await call("mako:cloud-account", []))
}
console.log("signed in with the cloud")
/**
 * Git in a Thread's worktree, waiting out another Git process's lock as Git asks: a harness runs `git status` as its
 * turn ends, which takes the index's lock for a moment.
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await run("git", ["-C", cwd, ...args])).stdout.trim()
    } catch (error) {
      if (attempt >= 20 || !String(error).includes(".lock': File exists")) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

const ChunkSchema = z.object({ record: z.string(), data: z.string(), next: z.number().nullable() }).loose()
const HistorySchema = z.object({
  base: z.object({ entries: z.array(z.unknown()).optional() }).loose().nullable(),
  blocks: z.array(z.unknown()),
  session: z.object({ status: z.string(), harness: z.string().nullish(), nativeId: z.string().nullish(), nativePath: z.string().nullish(), lastError: z.string().nullish() }).loose(),
}).loose()
/** A conversation's history as a window reads it: every part of the snapshot, once its base is read from its records. */
async function history(id: string): Promise<z.infer<typeof HistorySchema>> {
  for (const deadline = Date.now() + 60_000; ; await new Promise((resolve) => setTimeout(resolve, 500))) {
    const first = ChunkSchema.parse(await call("mako:live-read", [id, { kind: "snapshot" }]))
    let data = first.data
    for (let next = first.next; next !== null; ) {
      const part = ChunkSchema.parse(await call("mako:live-read", [id, { kind: "part", record: first.record, offset: next }]))
      data += part.data
      next = part.next
    }
    const read = HistorySchema.parse(JSON.parse(data))
    if (read.base !== null || Date.now() > deadline) return read
  }
}

const DescriptorSchema = z.array(z.object({ provider: z.string(), modes: z.array(z.object({ id: z.string(), access: z.string().optional() }).loose()).default([]) }).loose())
const descriptors = DescriptorSchema.parse(await call("mako:harness-descriptors", []))
/** The widest tier the harness offers: the proof is about where the work runs, not what it asks. */
const widestMode = (harness: string) => {
  const modes = descriptors.find((descriptor) => descriptor.provider === harness)?.modes ?? []
  for (const access of ["full", "auto", "edits"]) {
    const mode = modes.find((candidate) => candidate.access === access)
    if (mode) return mode.id
  }
  return undefined
}

const RequestSchema = z.object({
  id: z.string(),
  status: z.string(),
  error: z.string().optional(),
  failure: z.string().optional(),
  interruption: z.object({ reason: z.string() }).loose().optional(),
  continues: z.object({ requestId: z.string(), reason: z.string() }).loose().optional(),
}).loose()
const OptionSchema = z.object({ optionId: z.string(), kind: z.string().optional(), name: z.string().optional() }).loose()
const PermissionSchema = z.object({ id: z.string(), options: z.array(OptionSchema).default([]) }).loose()
const SnapshotSchema = z.object({
  session: z.object({ status: z.string(), cwd: z.string().nullish(), nativeId: z.string().nullish(), error: z.string().nullish() }).loose(),
  threadId: z.string().optional(),
  sessionId: z.string().optional(),
  elsewhere: z.string().optional(),
  permissions: z.array(PermissionSchema).default([]),
  requests: z.array(RequestSchema).default([]),
  blocks: z.array(z.object({ type: z.string() }).loose()).default([]),
}).loose()
type Snapshot = z.infer<typeof SnapshotSchema>
const OutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("moved"), cloudThread: z.string() }),
  z.object({ kind: z.literal("kept-here"), reason: z.string() }),
  z.object({ kind: z.literal("unsettled"), reason: z.string() }),
])
const ReturnOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("back") }),
  z.object({ kind: z.literal("stayed"), reason: z.string(), outdated: z.object({ harness: z.string(), installed: z.string().nullable(), offer: z.object({ kind: z.string() }).loose() }).loose().optional(), missing: z.object({ folder: z.string(), project: z.string().optional() }).optional() }),
  z.object({ kind: z.literal("unsettled"), reason: z.string(), waitsOn: z.string().optional() }),
])
const ReturnTimingsSchema = z.object({ phase: z.string(), timings: z.record(z.string(), z.number()), sessions: z.array(z.object({ conversationId: z.string(), begun: z.boolean().optional() }).loose()).default([]) }).loose()
const PlacementSchema = z.object({ thread: z.string(), session: z.string() })
const PlanTimingsSchema = z.object({ phase: z.string(), cloudThread: z.string(), folder: z.string(), timings: z.record(z.string(), z.number()), checkpoint: z.object({ bytes: z.number() }).loose().optional() }).loose()

const snapshot = async (id: string): Promise<Snapshot> => SnapshotSchema.parse(await call("mako:live-snapshot", [id]))
/**
 * Why a request ended as it did, in Mako's own words: its error, failure kind and interruption, then the session's last
 * error. A turn that fails before its harness says anything (a wake that couldn't restore its session) says why here.
 */
const ended = (shot: Snapshot, id: string): string => {
  const request = shot.requests.find((candidate) => candidate.id === id)
  const parts = [
    request?.status ?? "missing",
    request?.failure && `failure ${request.failure}`,
    request?.interruption && `interrupted (${request.interruption.reason})`,
    request?.error && `error: ${request.error.slice(0, 400)}`,
    shot.session.error && `session: ${shot.session.error.slice(0, 300)}`,
  ]
  return parts.filter(Boolean).join("; ")
}
/** Every word the blocks after `from` hold, the agent's prose and its tools' output alike. */
const blockText = (shot: Snapshot, from: number, only?: "text") =>
  shot.blocks
    .slice(from)
    .filter((block) => !only || block.type === only)
    .map((block) => JSON.stringify(block))
    .join("\n")
const proseText = (shot: Snapshot, from: number) =>
  shot.blocks.slice(from).filter((block) => block.type === "text").map((block) => z.object({ text: z.string() }).loose().safeParse(block).data?.text ?? "").join(" ")
const settled = (shot: Snapshot, request: string) => {
  const found = shot.requests.find((entry) => entry.id === request)
  return found !== undefined && !["queued", "dispatching", "running", "pending"].includes(found.status)
}

/** Waits on the conversation, answering each permission once with an allowing option, until `done`. */
async function until(id: string, done: (shot: Snapshot) => boolean, timeoutMs: number, answered: string[]): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const shot = await snapshot(id)
    for (const permission of shot.permissions) {
      if (answered.includes(permission.id)) continue
      const allow = permission.options.find((option) => option.kind === "allow_once") ??
        permission.options.find((option) => /allow|approve|yes|accept/i.test(`${option.kind ?? ""} ${option.name ?? ""} ${option.optionId}`) && !/always|session/i.test(`${option.kind ?? ""} ${option.optionId}`)) ??
        permission.options[0]
      answered.push(permission.id)
      await call("mako:live-permission", [id, permission.id, { kind: "choice", optionId: allow?.optionId ?? null }])
    }
    if (done(shot)) return shot
    if (Date.now() > deadline) throw new Error(`timed out; session ${shot.session.status}, requests ${shot.requests.map((request) => `${request.id.slice(0, 4)}:${request.status}`).join(" ")}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

type Step = { step: string; ms: number; ok: boolean; detail?: string }
/** What `mako:live-start` reads for a Thread in its own worktree, as the composer sends it. */
type StartOptions = { conversationId: string; worktree: true; modeId?: string; tuning?: { model: string }; initialRequest: { id: string; text: string; attachments: [] } }
type Proved = { steps: Step[]; conversation: string; timings?: Record<string, number> }
/** What `mako:live-start` reads for a `+` tab's first send, in the Session the tab made. */
type TabOptions = { conversationId: string; session: string; modeId?: string; initialRequest: { id: string; text: string; attachments: [] } }

async function prove(harness: string, project: string): Promise<Proved> {
  const steps: Step[] = []
  const proved = (): Proved => {
    const result: Proved = { steps, conversation: id }
    if (timings) result.timings = timings
    return result
  }
  const id = randomUUID()
  const answered: string[] = []
  const timed = async (step: string, work: () => Promise<string | undefined>) => {
    const started = performance.now()
    try {
      const detail = await work()
      const done: Step = { step, ms: Math.round(performance.now() - started), ok: true }
      if (detail) done.detail = detail
      steps.push(done)
    } catch (error) {
      steps.push({ step, ms: Math.round(performance.now() - started), ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
    const last = steps.at(-1)!
    console.log(`${harness.padEnd(9)} ${step.padEnd(30)} ${last.ok ? "ok  " : "FAIL"} ${String(last.ms).padStart(7)} ms  ${last.detail ?? ""}`)
    return last.ok
  }
  const token = `move-proof-${randomUUID().slice(0, 8)}`
  const committed = `committed-${randomUUID().slice(0, 8)}`
  const staged = `staged-${randomUUID().slice(0, 8)}`
  let folder = ""
  let timings: Record<string, number> | undefined
  const first = randomUUID()

  // 1. The Thread, in its own worktree, writing a file there.
  if (!(await timed("start in its worktree", async () => {
    const options: StartOptions = {
      conversationId: id,
      worktree: true,
      initialRequest: { id: first, text: `Create a file named move-proof.txt in the current folder containing exactly one line: ${token}\nDo not commit it. Then reply with one short sentence that includes the word WRITTEN.`, attachments: [] },
    }
    const mode = widestMode(harness)
    if (mode) options.modeId = mode
    await call("mako:live-start", [harness, project, options])
    const shot = await until(id, (current) => settled(current, first), 300_000, answered)
    folder = shot.session.cwd ?? ""
    if (!/\/worktrees\/[^/]+\/[^/]+$/.test(folder)) throw new Error(`not in a Thread worktree: ${folder}`)
    // What the agent said and did, when the file isn't what it was asked for: a model's miss reads apart from Mako's.
    const said = () => `; it said: ${blockText(shot, 0).replace(/\s+/g, " ").slice(0, 400)}`
    const written = (await readFile(join(folder, "move-proof.txt"), "utf8").catch(() => { throw new Error(`no move-proof.txt in ${folder}${said()}`) })).trim()
    if (written !== token) throw new Error(`move-proof.txt holds ${JSON.stringify(written.slice(0, 80))}${said()}`)
    return `${folder.replace(/^.*\/worktrees\//, "…/worktrees/")}, mode ${mode ?? "its one"}`
  }))) return proved()

  // 2. A commit and a staged file beside the agent's untracked one.
  await timed("commit and stage beside it", async () => {
    await writeFile(join(folder, "committed.txt"), `${committed}\n`)
    await git(folder, "add", "committed.txt")
    await git(folder, "-c", "user.name=Mako proof", "-c", "user.email=proof@mako.local", "commit", "-q", "-m", `move proof ${committed}`)
    await writeFile(join(folder, "staged.txt"), `${staged}\n`)
    await git(folder, "add", "staged.txt")
    return (await git(folder, "status", "--short")).replaceAll("\n", ", ")
  })

  // 3. A move asked while a turn runs: refused, nothing moved, and the turn goes on here.
  const busy = randomUUID()
  await timed("a move while working stays", async () => {
    await call("mako:live-prompt", [id, busy, "Run the shell command `node -e \"setTimeout(() => console.log('BUSY-DONE'), 20000)\"` in the foreground, then reply with the word FINISHED.", []])
    const before = (await snapshot(id)).blocks.length
    await until(id, (current) => ["dispatching", "running"].includes(current.requests.find((request) => request.id === busy)?.status ?? "") && current.blocks.length > before, 120_000, answered)
    const outcome = OutcomeSchema.parse(await call("mako:thread-move", [id, randomUUID()]))
    if (outcome.kind !== "kept-here") throw new Error(`a busy Thread moved: ${JSON.stringify(outcome)}`)
    const shot = await until(id, (current) => settled(current, busy), 240_000, answered)
    const status = shot.requests.find((request) => request.id === busy)?.status
    if (status !== "completed") throw new Error(`the turn didn't finish here after the refused move: ${ended(shot, busy)}`)
    return outcome.reason
  })

  // 4. The move, then the same move asked again.
  const move = randomUUID()
  let cloudThread = ""
  let refused: string | undefined
  if (!(await timed("move to the cloud", async () => {
    const outcome = OutcomeSchema.parse(await call("mako:thread-move", [id, move]))
    // A host of its own shares no sign-ins: a harness that can't start without one is refused before the claim.
    if (outcome.kind === "kept-here" && /couldn't start in the cloud: .* Mako Cloud has no sign-in for /.test(outcome.reason)) {
      refused = outcome.reason
      return `refused before the claim: ${outcome.reason.slice(0, 160)}`
    }
    if (outcome.kind !== "moved") throw new Error(`${outcome.kind}: ${outcome.reason}`)
    cloudThread = outcome.cloudThread
    const plan = PlanTimingsSchema.parse(JSON.parse(await readFile(join(dataRoot, "cloud", "moves", `${move}.json`), "utf8")))
    timings = plan.timings
    if (plan.phase !== "started") throw new Error(`the plan reads ${plan.phase}`)
    const order = ["made", "ahead", "released", "sent", "arrived", "claimed", "started"]
    return `${cloudThread}; ${order.filter((name) => name in plan.timings).map((name) => `${name} ${(plan.timings[name]! / 1000).toFixed(1)} s`).join(", ")}; checkpoint ${plan.checkpoint ? `${(plan.checkpoint.bytes / 1024).toFixed(0)} KiB` : "?"}`
  }))) return proved()
  if (refused !== undefined) {
    // Taken back here whole: the same move answers the same, and a turn runs here, in the same session.
    await timed("runs here after the refusal", async () => {
      const again = OutcomeSchema.parse(await call("mako:thread-move", [id, move]))
      if (again.kind !== "kept-here") throw new Error(`the same move answered ${JSON.stringify(again)}`)
      const back = randomUUID()
      await call("mako:live-prompt", [id, back, "Reply with one short sentence that includes the word BACK.", []])
      const shot = await until(id, (current) => settled(current, back), 300_000, answered)
      const status = shot.requests.find((request) => request.id === back)?.status
      if (status !== "completed") throw new Error(`the turn here ended ${ended(shot, back)}`)
      return "the same answer again; a turn ran here"
    })
    return proved()
  }
  await timed("the same move again", async () => {
    const outcome = OutcomeSchema.parse(await call("mako:thread-move", [id, move]))
    if (outcome.kind !== "moved" || outcome.cloudThread !== cloudThread) throw new Error(`answered ${JSON.stringify(outcome)}`)
    return undefined
  })

  // 5: the machine's side read from the conversation's history as the machine serves it.
  await timed("its history in the cloud", async () => {
    const seen = await history(id)
    const read = JSON.stringify(seen)
    // What the machine showed, so a failure says where it stopped: its base unread, empty, or read without the turn.
    const showed = `base ${seen.base === null ? "unread" : `${seen.base.entries?.length ?? 0} entries`}, ${seen.blocks.length} live blocks, session ${seen.session.status} at ${seen.session.nativePath ?? "no path"}${seen.session.lastError ? `, last error: ${seen.session.lastError.slice(0, 200)}` : ""}`
    if (!read.includes(token)) throw new Error(`the machine's history of the conversation doesn't hold its first turn (${showed})`)
    if (!read.includes("BUSY-DONE")) throw new Error(`the machine's history doesn't hold the turn that finished here before the move (${showed})`)
    return "both turns from before the move, read on the machine"
  })
  // 6. Conversations begun in the cloud: a new tab of the Thread's and a fork of it, each a turn on the machine.
  const tabHarness = values["tab-harness"] ?? harness
  const tab = randomUUID()
  const fork = randomUUID()
  const tabToken = `tab-proof-${randomUUID().slice(0, 8)}`
  const tabTurn = randomUUID()
  let tabSession = ""
  const recall = `Without running anything, reply with one line starting with MEMORY: followed by the exact line you replied with first in this conversation.`
  const tabbed = await timed("a new tab in the cloud", async () => {
    const threadId = (await snapshot(id)).threadId
    if (!threadId) throw new Error("the moved conversation names no Thread")
    tabSession = PlacementSchema.parse(await call("mako:thread-create-session", [randomUUID(), threadId])).session
    const mode = widestMode(tabHarness)
    const options: TabOptions = { conversationId: tab, session: tabSession, initialRequest: { id: tabTurn, text: `Without running anything, reply with exactly this line and nothing else: ${tabToken}`, attachments: [] }, ...mode && { modeId: mode } }
    const started = SnapshotSchema.parse(await call("mako:live-start", [tabHarness, folder, options]))
    if (!started.elsewhere) throw new Error("the new tab started on this Mac, not in the cloud with its Thread")
    const shot = await until(tab, (current) => settled(current, tabTurn), 300_000, answered)
    if (shot.requests.find((request) => request.id === tabTurn)?.status !== "completed") throw new Error(`its turn ended ${ended(shot, tabTurn)}`)
    if (!proseText(shot, 0).includes(tabToken)) throw new Error(`it didn't say the line: ${proseText(shot, 0).slice(0, 200)}`)
    if (shot.sessionId !== tabSession) throw new Error(`the machine put it in Session ${shot.sessionId ?? "none"}, not the tab's ${tabSession}`)
    return `${tabHarness}, in the tab's Session on the machine`
  })
  const forked = tabbed && (await timed("a fork of it in the cloud", async () => {
    const made = SnapshotSchema.parse(await call("mako:live-fork", [tab, { id: fork, provider: tabHarness, point: { kind: "run", requestId: tabTurn } }]))
    if (!made.elsewhere) throw new Error("the fork was made on this Mac, not in the cloud")
    const turn = randomUUID()
    await call("mako:live-prompt", [fork, turn, recall, []])
    const shot = await until(fork, (current) => settled(current, turn), 300_000, answered)
    if (shot.requests.find((request) => request.id === turn)?.status !== "completed") throw new Error(`its turn ended ${ended(shot, turn)}`)
    if (!proseText(shot, 0).includes(tabToken)) throw new Error(`it didn't remember the line: ${proseText(shot, 0).slice(0, 200)}`)
    if (!shot.sessionId || shot.sessionId === tabSession) throw new Error(`it isn't in a Session of its own: ${shot.sessionId ?? "none"}`)
    return "remembered the tab's line, in a Session of its own"
  }))

  // 7. The way back: the machine's checkout and every session come back here, and a turn here remembers the first.
  const back = randomUUID()
  if (!(await timed("back to this Mac", async () => {
    const outcome = ReturnOutcomeSchema.parse(await call("mako:thread-return", [id, back]))
    if (outcome.kind !== "back") throw new Error(`${outcome.kind}: ${outcome.reason}`)
    const plan = ReturnTimingsSchema.parse(JSON.parse(await readFile(join(dataRoot, "cloud", "returns", `${back}.json`), "utf8")))
    if (plan.phase !== "done") throw new Error(`the return's plan reads ${plan.phase}`)
    const carried = plan.sessions.filter((session) => session.begun).map((session) => session.conversationId)
    const expected = [...tabbed ? [tab] : [], ...forked ? [fork] : []]
    if (expected.some((each) => !carried.includes(each))) throw new Error(`the return carried ${carried.length} begun in the cloud, not the tab and fork`)
    const files = [(await readFile(join(folder, "move-proof.txt"), "utf8")).trim(), (await readFile(join(folder, "staged.txt"), "utf8")).trim(), await git(folder, "log", "-1", "--format=%s")]
    if (files[0] !== token || files[1] !== staged || files[2] !== `move proof ${committed}`) throw new Error(`the worktree came back as ${JSON.stringify(files)}`)
    const order = ["packed", "released", "applied", "claimed", "done"]
    return order.filter((name) => name in plan.timings).map((name) => `${name} ${(plan.timings[name]! / 1000).toFixed(1)} s`).join(", ")
  }))) return proved()
  await timed("the same return again", async () => {
    const outcome = ReturnOutcomeSchema.parse(await call("mako:thread-return", [id, back]))
    if (outcome.kind !== "back") throw new Error(`answered ${JSON.stringify(outcome)}`)
    return undefined
  })
  await timed("a turn here after", async () => {
    const here = randomUUID()
    const before = (await snapshot(id)).blocks.length
    await call("mako:live-prompt", [id, here, "Without running anything, write one line starting with MEMORY: followed by the exact line you wrote into move-proof.txt earlier in this conversation, from memory.", []])
    const shot = await until(id, (current) => settled(current, here), 300_000, answered)
    const status = shot.requests.find((request) => request.id === here)?.status
    if (status !== "completed") throw new Error(`the turn ended ${ended(shot, here)}; said: ${proseText(shot, before).slice(0, 200)}`)
    if (!proseText(shot, before).includes(token)) throw new Error(`it didn't remember the token: ${proseText(shot, before).slice(0, 300)}`)
    return "the same session: remembered the token"
  })
  // Each begun in the cloud goes on here, in its own native session: it remembers what it said there.
  for (const [step, conversation] of [["the new tab here", tabbed && tab], ["the fork here", forked && fork]] as const) {
    if (!conversation) continue
    await timed(step, async () => {
      const turn = randomUUID()
      const shot0 = await snapshot(conversation)
      if (shot0.elsewhere) throw new Error("this Mac still reads it as the cloud's")
      const before = shot0.blocks.length
      await call("mako:live-prompt", [conversation, turn, recall, []])
      const shot = await until(conversation, (current) => settled(current, turn), 300_000, answered)
      if (shot.requests.find((request) => request.id === turn)?.status !== "completed") throw new Error(`the turn ended ${ended(shot, turn)}; said: ${proseText(shot, before).slice(0, 200)}`)
      if (!proseText(shot, before).includes(tabToken)) throw new Error(`it didn't remember the line: ${proseText(shot, before).slice(0, 300)}`)
      return "the same session: remembered its line from the cloud"
    })
  }
  return proved()
}

/**
 * The cloud full: `places` cloud conversations take every machine place, then a move of `conversation`'s Thread, back
 * here from an earlier step, is asked. It must be refused before anything is released, at once, saying the cloud is
 * full, rather than wait in the cloud's queue for a place.
 */
/** How long a cloud start may take before it reads as waiting for a place: a machine's boot and clone, with room. */
const FULL_START_MS = 90_000

async function fullCloud(places: number, conversation: string): Promise<Proved> {
  const steps: Step[] = []
  const timed = async (step: string, work: () => Promise<string>) => {
    const started = performance.now()
    const done: Step = await work().then(
      (detail) => ({ step, ms: Math.round(performance.now() - started), ok: true, detail }),
      (error: Error) => ({ step, ms: Math.round(performance.now() - started), ok: false, detail: error.message }),
    )
    steps.push(done)
    console.log(`${"full".padEnd(9)} ${step.padEnd(30)} ${done.ok ? "ok  " : "FAIL"} ${String(done.ms).padStart(7)} ms  ${done.detail ?? ""}`)
    return done.ok
  }
  const filled = await timed("the cloud's places taken", async () => {
    // A Thread an earlier step left in the cloud may hold a place already: a start that waits for one means it's full.
    let started = 0
    for (let place = 0; place < places; place++) {
      const start = call("mako:live-start", ["opencode", project, { conversationId: randomUUID(), cloud: { repository: { url: values.repository } } }])
      const waiting = new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), FULL_START_MS).unref())
      if ((await Promise.race([start.then(() => "started" as const), waiting])) === "waiting") {
        // Left to wait in the cloud's queue; the run's end takes it with the cloud.
        start.catch(() => undefined)
        return `${started} started; the next waited for a place, so the cloud is full`
      }
      started += 1
    }
    return `${started} cloud conversations running`
  })
  if (filled) await timed("a move into a full cloud", async () => {
    const began = performance.now()
    const outcome = OutcomeSchema.parse(await call("mako:thread-move", [conversation, randomUUID()]))
    const ms = performance.now() - began
    if (outcome.kind !== "kept-here") throw new Error(`it ${outcome.kind === "moved" ? "moved" : `was ${outcome.kind}: ${outcome.reason}`}`)
    if (!/full/i.test(outcome.reason)) throw new Error(`refused, but not for a full cloud: ${outcome.reason}`)
    if (ms > 20_000) throw new Error(`refused only after ${(ms / 1000).toFixed(1)} s: ${outcome.reason}`)
    const shot = await snapshot(conversation)
    if (shot.elsewhere) throw new Error("the conversation reads as the cloud's after the refusal")
    return outcome.reason
  })
  return { steps, conversation }
}

/**
 * Rule 2 of moves, end to end: a Thread whose agent is mid-turn is handed to the cloud. The turn pauses here, the
 * Thread moves with it, and Mako continues the turn on the machine, where it finishes what it was doing; then the
 * Thread comes back with the file the turn wrote there.
 */
async function handOffProof(harness: string, project: string): Promise<Proved> {
  const steps: Step[] = []
  const id = randomUUID()
  const answered: string[] = []
  let timings: Record<string, number> | undefined
  const timed = async (step: string, work: () => Promise<string>) => {
    const started = performance.now()
    const done: Step = await work().then(
      (detail) => ({ step, ms: Math.round(performance.now() - started), ok: true, detail }),
      (error: Error) => ({ step, ms: Math.round(performance.now() - started), ok: false, detail: error.message }),
    )
    steps.push(done)
    console.log(`${"handoff".padEnd(9)} ${step.padEnd(30)} ${done.ok ? "ok  " : "FAIL"} ${String(done.ms).padStart(7)} ms  ${done.detail ?? ""}`)
    return done.ok
  }
  const proved = (): Proved => ({ steps, conversation: id, ...timings && { timings } })
  const token = `handoff-proof-${randomUUID().slice(0, 8)}`
  const command = `sleep ${90 + Number(values["handoff-wait"] ?? 0)} && echo ${token} > handoff-proof.txt`
  const first = randomUUID()
  let folder = ""

  // The agent's own call of the command, not the prompt that names it.
  const running = (shot: Snapshot) => shot.blocks.some((block) => block.type !== "user" && block.type !== "text" && JSON.stringify(block).includes(command.split(" &&")[0]!))

  // 1. A turn at work in a Thread's worktree: the agent is inside a long command.
  if (!(await timed("a turn at work", async () => {
    const mode = widestMode(harness)
    const model = await freeModel(harness, project)
    const options: StartOptions = {
      conversationId: id,
      worktree: true,
      ...model && { tuning: { model } },
      initialRequest: { id: first, text: `Run this shell command in the foreground and wait for it to finish: \`${command}\`\nThen reply with one short sentence that includes the word FINISHED.`, attachments: [] },
      ...mode && { modeId: mode },
    }
    await call("mako:live-start", [harness, project, options])
    const shot = await until(id, (current) => ["dispatching", "running"].includes(current.requests.find((request) => request.id === first)?.status ?? "") && running(current), 300_000, answered)
    folder = shot.session.cwd ?? ""
    // Kept ready while it works, as handing off on sleep has it: a round sends it ahead within half a minute or so.
    const ready = join(dataRoot, "cloud", "ready.json")
    const kept = async () => Object.keys(z.object({ threads: z.record(z.string(), z.unknown()) }).loose().safeParse(JSON.parse(await readFile(ready, "utf8").catch(() => "null"))).data?.threads ?? {}).length > 0
    for (const deadline = Date.now() + 60_000; !(await kept()) && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 1_000))
    if (!(await kept())) throw new Error("no cloud Thread stood by for it within a minute")
    const wait = Number(values["handoff-wait"] ?? 0)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait * 1000))
    return `${harness}${model ? ` on ${model}` : ""} running \`${command.replace(token, "…")}\``
  }))) return proved()

  // 2. Handed off mid-turn: the turn pauses, the Thread moves, the turn is carried.
  const by = values["handoff-by"]
  if (!(await timed("handed off mid-turn", async () => {
    let move: string = randomUUID()
    let how = ""
    if (by === "asked") {
      const outcome = OutcomeSchema.parse(await call("mako:thread-move", [id, move, { why: "asked" }]))
      if (outcome.kind !== "moved") throw new Error(`${outcome.kind}: ${outcome.reason}`)
    } else if (by === "quit") {
      how = await quitThroughWindow()
      move = await handedOffBy(id, "quit", 120_000)
    } else if (by === "sleep") {
      console.log("CLOSE THE LID NOW: the Thread is at work and kept ready; keep it closed for a minute, then open it")
      move = await handedOffBy(id, "sleep", 30 * 60_000)
      how = "the lid closed"
    } else throw new Error(`--handoff-by ${by}: asked, quit or sleep`)
    const plan = PlanTimingsSchema.parse(JSON.parse(await readFile(join(dataRoot, "cloud", "moves", `${move}.json`), "utf8")))
    timings = plan.timings
    if (plan.phase !== "started") throw new Error(`the plan reads ${plan.phase}`)
    const order = ["made", "ready", "ahead", "paused", "released", "sent", "arrived", "claimed", "started"]
    return `${by === "asked" ? "" : `by ${by}${how ? ` (${how})` : ""}: `}${plan.cloudThread}${"standby" in plan.timings ? ", the one kept ready" : ", a new one"}; ${order.filter((name) => name in plan.timings).map((name) => `${name} ${(plan.timings[name]! / 1000).toFixed(1)} s`).join(", ")}`
  }))) return proved()

  // 3. The turn goes on there: Mako's continuation of the paused turn finishes on the machine.
  if (!(await timed("the turn goes on in the cloud", async () => {
    const shot = await until(id, (current) => current.requests.some((request) => request.continues?.reason === "handed-off" && settled(current, request.id)), 600_000, answered)
    const continued = shot.requests.find((request) => request.continues?.reason === "handed-off")!
    if (continued.continues?.requestId !== first) throw new Error(`the continuation continues ${continued.continues?.requestId}`)
    // The turn paused mid-way, or, when the agent had sent its command to the background and ended it, the command
    // stopped and named in the continuation's words.
    const paused = shot.requests.find((request) => request.id === first)
    const named = blockText(shot, 0).includes("The handoff stopped what you had left running in the background")
    if (paused && paused.interruption?.reason !== "handed-off" && !named) throw new Error(`the first turn reads ${ended(shot, first)}, and nothing stopped was named`)
    const how = paused?.interruption?.reason === "handed-off" ? "its turn paused here" : "its background command stopped and named"
    if (continued.status !== "completed") throw new Error(`the continuation ended ${ended(shot, continued.id)}`)
    // An agent that starts the command again in the background ends that turn and answers when it's done, in a turn
    // it starts on the command's notification: waited for, as long as the command runs and a minute or two more.
    const done = await until(id, (current) => proseText(current, 0).includes("FINISHED") || current.session.status === "failed", (100 + Number(values["handoff-wait"] ?? 0) + 180) * 1000, answered)
      .catch((error: Error) => { throw new Error(`it didn't say FINISHED: ${error.message}; said: ${proseText(shot, 0).slice(-300)}`) })
    if (!proseText(done, 0).includes("FINISHED")) throw new Error(`it didn't say FINISHED: ${done.session.error ?? proseText(done, 0).slice(-300)}`)
    return `${how}, continued and finished on the machine`
  }))) return proved()

  // 4. Back with what the turn wrote there.
  await timed("back with its work", async () => {
    const outcome = ReturnOutcomeSchema.parse(await call("mako:thread-return", [id, randomUUID()]))
    // This Mac's harness older than the machine's, which wrote the continued turn: the way back stays, offering the
    // update, and the Thread goes on in the cloud whole.
    if (outcome.kind === "stayed" && outcome.outdated) {
      if ((await snapshot(id)).elsewhere === undefined) throw new Error("it stayed, but the conversation reads as this Mac's")
      return `stayed, rightly: ${outcome.reason.slice(0, 200)}; offered ${outcome.outdated.offer.kind} for ${outcome.outdated.harness} ${outcome.outdated.installed ?? "not installed"}`
    }
    if (outcome.kind !== "back") throw new Error(`${outcome.kind}: ${outcome.reason}`)
    const written = (await readFile(join(folder, "handoff-proof.txt"), "utf8").catch(() => "")).trim()
    if (written !== token) throw new Error(`handoff-proof.txt holds ${JSON.stringify(written.slice(0, 80))}`)
    return "handoff-proof.txt came back as the turn wrote it in the cloud"
  })
  return proved()
}

/**
 * Forks of a tab begun in the cloud, `count` of them on its machine, each without a turn: every one must be in a
 * Session of its own, which the Mac files under the same ID as the machine. One in twelve was once filed into its
 * parent's Session (2026-10-23); this looks for that.
 */
async function forkBurst(harness: string, project: string, count: number): Promise<Proved> {
  const steps: Step[] = []
  const id = randomUUID()
  const answered: string[] = []
  const timed = async (step: string, work: () => Promise<string>) => {
    const started = performance.now()
    const done: Step = await work().then(
      (detail) => ({ step, ms: Math.round(performance.now() - started), ok: true, detail }),
      (error: Error) => ({ step, ms: Math.round(performance.now() - started), ok: false, detail: error.message }),
    )
    steps.push(done)
    console.log(`${"forks".padEnd(9)} ${step.padEnd(30)} ${done.ok ? "ok  " : "FAIL"} ${String(done.ms).padStart(7)} ms  ${done.detail ?? ""}`)
    return done.ok
  }
  const first = randomUUID()
  const mode = widestMode(harness)
  let folder = ""
  if (!(await timed("a Thread, moved", async () => {
    await call("mako:live-start", [harness, project, { conversationId: id, worktree: true, ...mode && { modeId: mode }, initialRequest: { id: first, text: "Without running anything, reply with the word READY.", attachments: [] } }])
    const shot = await until(id, (current) => settled(current, first), 300_000, answered)
    folder = shot.session.cwd ?? ""
    const outcome = OutcomeSchema.parse(await call("mako:thread-move", [id, randomUUID()]))
    if (outcome.kind !== "moved") throw new Error(`${outcome.kind}: ${outcome.reason}`)
    return outcome.cloudThread
  }))) return { steps, conversation: id }
  const tab = randomUUID()
  const tabTurn = randomUUID()
  let tabSession = ""
  if (!(await timed("a tab in the cloud", async () => {
    const threadId = (await snapshot(id)).threadId
    if (!threadId) throw new Error("the moved conversation names no Thread")
    tabSession = PlacementSchema.parse(await call("mako:thread-create-session", [randomUUID(), threadId])).session
    await call("mako:live-start", [harness, folder, { conversationId: tab, session: tabSession, ...mode && { modeId: mode }, initialRequest: { id: tabTurn, text: "Without running anything, reply with the word TAB.", attachments: [] } }])
    const shot = await until(tab, (current) => settled(current, tabTurn), 300_000, answered)
    if (shot.sessionId !== tabSession) throw new Error(`the machine put it in Session ${shot.sessionId ?? "none"}, not the tab's`)
    return tabSession
  }))) return { steps, conversation: id }
  await timed(`${count} forks of it`, async () => {
    const sessions = new Set<string>([tabSession])
    const wrong: string[] = []
    for (let n = 0; n < count; n++) {
      const fork = randomUUID()
      const made = SnapshotSchema.parse(await call("mako:live-fork", [tab, { id: fork, provider: harness, point: { kind: "run", requestId: tabTurn } }]))
      if (!made.elsewhere) throw new Error(`fork ${n + 1} was made on this Mac`)
      const session = made.sessionId ?? (await snapshot(fork)).sessionId
      if (!session || sessions.has(session)) wrong.push(`fork ${n + 1}: Session ${session ?? "none"}${session === tabSession ? " (the tab's)" : ""}`)
      if (session) sessions.add(session)
    }
    if (wrong.length) throw new Error(`${wrong.length} of ${count} not in a Session of their own: ${wrong.join("; ")}`)
    return `each in a Session of its own`
  })
  return { steps, conversation: id }
}

/**
 * A Thread whose project moves away while it runs in the cloud, as a person moving or deleting the project folder does.
 * In a clone of its own, so the move touches no other proof's Threads.
 */
async function projectGoneProof(harness: string): Promise<Proved> {
  const steps: Step[] = []
  const id = randomUUID()
  const answered: string[] = []
  const timed = async (step: string, work: () => Promise<string>) => {
    const started = performance.now()
    const done: Step = await work().then(
      (detail) => ({ step, ms: Math.round(performance.now() - started), ok: true, detail }),
      (error: Error) => ({ step, ms: Math.round(performance.now() - started), ok: false, detail: error.message }),
    )
    steps.push(done)
    console.log(`${"gone".padEnd(9)} ${step.padEnd(30)} ${done.ok ? "ok  " : "FAIL"} ${String(done.ms).padStart(7)} ms  ${done.detail ?? ""}`)
    return done.ok
  }
  const own = join(scratch, "gone-project")
  const moved = join(scratch, "moved-project")
  await run("git", ["clone", "-q", values.repository, own])
  const token = `gone-proof-${randomUUID().slice(0, 8)}`
  const first = randomUUID()
  const mode = widestMode(harness)
  let folder = ""
  if (!(await timed("a Thread, moved", async () => {
    const model = await freeModel(harness, own)
    await call("mako:live-start", [harness, own, { conversationId: id, worktree: true, ...mode && { modeId: mode }, ...model && { tuning: { model } }, initialRequest: { id: first, text: `Create a file named gone-proof.txt in the current folder containing exactly one line: ${token}\nDo not commit it. Then reply with one short sentence that includes the word WRITTEN.`, attachments: [] } }])
    const shot = await until(id, (current) => settled(current, first), 300_000, answered)
    folder = shot.session.cwd ?? ""
    if ((await readFile(join(folder, "gone-proof.txt"), "utf8").catch(() => "")).trim() !== token) throw new Error(`no gone-proof.txt in ${folder}`)
    const outcome = OutcomeSchema.parse(await call("mako:thread-move", [id, randomUUID()]))
    if (outcome.kind !== "moved") throw new Error(`${outcome.kind}: ${outcome.reason}`)
    return outcome.cloudThread
  }))) return { steps, conversation: id }
  await rename(own, moved)
  const refused = randomUUID()
  if (!(await timed("refused, its project gone", async () => {
    const outcome = ReturnOutcomeSchema.parse(await call("mako:thread-return", [id, refused]))
    if (outcome.kind !== "stayed") throw new Error(`${outcome.kind}${outcome.kind === "unsettled" ? `: ${outcome.reason}` : ""}`)
    if (outcome.missing?.project !== own || outcome.missing.folder !== folder) throw new Error(`stayed without naming the project: ${JSON.stringify(outcome)}`)
    // Refused before the cloud was asked: no plan was written, so nothing was begun.
    if (await lstat(join(dataRoot, "cloud", "returns", `${refused}.json`)).then(() => true, () => false)) throw new Error("a return was planned and begun")
    return outcome.reason
  }))) return { steps, conversation: id }
  // Still the cloud's: a turn runs on its machine, which is Linux, at the same folder.
  await timed("a turn in the cloud after", async () => {
    const turn = randomUUID()
    const before = (await snapshot(id)).blocks.length
    await call("mako:live-prompt", [id, turn, "Run the shell command `uname -s; pwd` and show its output, then reply with the word STILL.", []])
    const shot = await until(id, (current) => settled(current, turn), 300_000, answered)
    const status = shot.requests.find((request) => request.id === turn)?.status
    if (status !== "completed") throw new Error(`the turn ended ${ended(shot, turn)}`)
    const said = blockText(shot, before)
    if (!said.includes("Linux") || !said.includes(folder)) throw new Error(`it didn't run on its machine: ${said.replace(/\s+/g, " ").slice(0, 300)}`)
    return "on its machine (Linux), at the same folder"
  })
  await timed("back into the moved project", async () => {
    const outcome = ReturnOutcomeSchema.parse(await call("mako:thread-return", [id, randomUUID(), { project: moved }]))
    if (outcome.kind !== "back") throw new Error(`${outcome.kind}: ${outcome.reason}`)
    const written = (await readFile(join(folder, "gone-proof.txt"), "utf8")).trim()
    if (written !== token) throw new Error(`gone-proof.txt holds ${JSON.stringify(written.slice(0, 80))}`)
    const common = await git(folder, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if (!common.startsWith(moved)) throw new Error(`its worktree belongs to ${common}`)
    return `its worktree at the same folder, of ${moved.replace(scratch, "…")}`
  })
  return { steps, conversation: id }
}

/** What archiving answers (`ArchiveAnswer`): the keys as they stand, and how the cloud Thread's archive went. */
const ArchiveAnswerSchema = z.object({ keys: z.array(z.string()), cloud: z.object({ kind: z.string(), thread: z.string(), reason: z.string().optional() }).optional() }).loose()

/** Whether the host shows the conversation archived (`want`) within 15 s, as every window's snapshot says. */
async function shownArchived(conversation: string, want: boolean): Promise<boolean> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 100)))
    if (ArchiveAnswerSchema.parse(await call("mako:thread-archives", [])).keys.includes(`live:${conversation}`) === want) return true
  return false
}

async function archiveProof(harness: string): Promise<Proved> {
  const steps: Step[] = []
  const id = randomUUID()
  const answered: string[] = []
  const timed = async (step: string, work: () => Promise<string>) => {
    const started = performance.now()
    const done: Step = await work().then(
      (detail) => ({ step, ms: Math.round(performance.now() - started), ok: true, detail }),
      (error: Error) => ({ step, ms: Math.round(performance.now() - started), ok: false, detail: error.message }),
    )
    steps.push(done)
    console.log(`${"archive".padEnd(9)} ${step.padEnd(30)} ${done.ok ? "ok  " : "FAIL"} ${String(done.ms).padStart(7)} ms  ${done.detail ?? ""}`)
    return done.ok
  }
  const own = join(scratch, "archive-project")
  await run("git", ["clone", "-q", values.repository, own])
  const token = `archive-proof-${randomUUID().slice(0, 8)}`
  const cloudToken = `archived-cloud-${randomUUID().slice(0, 8)}`
  const mode = widestMode(harness)
  let folder = ""
  let cloudThread = ""
  if (!(await timed("a Thread, moved", async () => {
    const model = await freeModel(harness, own)
    const first = randomUUID()
    await call("mako:live-start", [harness, own, { conversationId: id, worktree: true, ...mode && { modeId: mode }, ...model && { tuning: { model } }, initialRequest: { id: first, text: `Create a file named archive-proof.txt in the current folder containing exactly one line: ${token}\nDo not commit it. Then reply with one short sentence that includes the word WRITTEN.`, attachments: [] } }])
    const shot = await until(id, (current) => settled(current, first), 300_000, answered)
    folder = shot.session.cwd ?? ""
    const outcome = OutcomeSchema.parse(await call("mako:thread-move", [id, randomUUID()]))
    if (outcome.kind !== "moved") throw new Error(`${outcome.kind}: ${outcome.reason}`)
    cloudThread = outcome.cloudThread
    return cloudThread
  }))) return { steps, conversation: id }
  // What its machine's checkout holds only in the cloud: archiving keeps it, and restoring brings it here. Only where a
  // turn runs on a machine with no sign-ins (OpenCode's free models): another harness's would wait there for one.
  const wroteThere = (await freeModel(harness, own)) !== undefined && await timed("a turn in the cloud", async () => {
    const turn = randomUUID()
    await call("mako:live-prompt", [id, turn, `Create a file named archive-cloud.txt in the current folder containing exactly one line: ${cloudToken}\nDo not commit it. Then reply with the word DONE.`, []])
    const shot = await until(id, (current) => settled(current, turn), 300_000, answered)
    const status = shot.requests.find((request) => request.id === turn)?.status
    if (status !== "completed") throw new Error(`the turn ended ${ended(shot, turn)}`)
    return "archive-cloud.txt written on its machine"
  })
  const archive = { id: randomUUID(), target: { kind: "live", id }, archived: true }
  if (!(await timed("archived from this Mac", async () => {
    const answer = ArchiveAnswerSchema.parse(await call("mako:thread-archive", [archive]))
    if (answer.cloud?.kind !== "archived") throw new Error(`${answer.cloud?.kind ?? "archived here only"}: ${answer.cloud?.reason ?? ""}`)
    // Shown archived by the account's word, as its stream says it a moment later: never a key of this Mac's own.
    if (!(await shownArchived(id, true))) throw new Error("this Mac doesn't show it archived")
    const plan = z.object({ phase: z.string() }).loose().parse(JSON.parse(await readFile(join(dataRoot, "cloud", "archives", `${archive.id}.json`), "utf8")))
    if (plan.phase !== "archived") throw new Error(`its plan reads ${plan.phase}`)
    console.log(`ARCHIVED ${cloudThread}`)
    return `its machine packed and ended; archived by the account's word`
  }))) return { steps, conversation: id }
  await timed("asked again: the same", async () => {
    const answer = ArchiveAnswerSchema.parse(await call("mako:thread-archive", [archive]))
    if (answer.cloud?.kind !== "archived") throw new Error(JSON.stringify(answer.cloud))
    return "archived, nothing asked twice"
  })
  await timed("a call refused", async () => {
    const refused = await call("mako:live-prompt", [id, randomUUID(), "Reply with the word NO.", []]).then(() => undefined, (error: Error) => error.message)
    if (!refused) throw new Error("a message to an archived Thread was taken")
    if (!/archived/i.test(refused)) throw new Error(refused)
    return refused
  })
  await timed("restored here", async () => {
    const answer = ArchiveAnswerSchema.parse(await call("mako:thread-archive", [{ id: randomUUID(), target: { kind: "live", id }, archived: false }]))
    if (answer.cloud?.kind !== "restored") throw new Error(`${answer.cloud?.kind}: ${answer.cloud?.reason ?? ""}`)
    if (!(await shownArchived(id, false))) throw new Error("still shown archived")
    if ((await readFile(join(folder, "archive-proof.txt"), "utf8")).trim() !== token) throw new Error("archive-proof.txt didn't come back")
    if (wroteThere && (await readFile(join(folder, "archive-cloud.txt"), "utf8").catch(() => "")).trim() !== cloudToken) throw new Error("what it wrote in the cloud didn't come back")
    console.log(`RESTORED ${cloudThread}`)
    return wroteThere ? "back here with what it wrote here and in the cloud" : "back here with what it wrote here"
  })
  return { steps, conversation: id }
}

/**
 * Machines cloned from one image, each asked for fresh randomness: a new process's random UUID, the kernel's boot id
 * and whether the kernel has a VM generation counter (which reseeds it as a snapshot is restored). Two machines that
 * print the same UUID draw the same randomness, and so mint the same IDs.
 */
async function entropy(harness: string, project: string, count: number): Promise<Proved> {
  const steps: Step[] = []
  const answered: string[] = []
  const seen: Array<{ uuid: string; boot: string; vmgenid: string }> = []
  const mode = widestMode(harness)
  const started = performance.now()
  for (let n = 0; n < count; n++) {
    const id = randomUUID()
    const first = randomUUID()
    await call("mako:live-start", [harness, project, { conversationId: id, worktree: true, ...mode && { modeId: mode }, initialRequest: { id: first, text: "Without running anything, reply with the word READY.", attachments: [] } }])
    await until(id, (current) => settled(current, first), 300_000, answered)
    const outcome = OutcomeSchema.parse(await call("mako:thread-move", [id, randomUUID()]))
    if (outcome.kind !== "moved") throw new Error(`${outcome.kind}: ${outcome.reason}`)
    const turn = randomUUID()
    const command = `node -e 'console.log("UUID " + require("crypto").randomUUID())'; echo "BOOT $(cat /proc/sys/kernel/random/boot_id)"; echo "VMGENID $(ls /sys/bus/acpi/devices 2>/dev/null | grep -ci -e vmgen -e qemuvgid)"`
    await call("mako:live-prompt", [id, turn, `Run this exact shell command and reply with its output verbatim and nothing else: ${command}`, []])
    const shot = await until(id, (current) => settled(current, turn), 300_000, answered)
    const text = proseText(shot, 0) + JSON.stringify(shot.blocks)
    const pick = (label: string) => new RegExp(`${label} ([0-9a-f-]+)`).exec(text)?.[1] ?? "?"
    seen.push({ uuid: pick("UUID"), boot: pick("BOOT"), vmgenid: pick("VMGENID") })
    console.log(`${"entropy".padEnd(9)} machine ${n + 1}: ${JSON.stringify(seen.at(-1))}`)
  }
  const uuids = new Set(seen.map((each) => each.uuid))
  const ok = uuids.size === seen.length && !uuids.has("?")
  steps.push({ step: `${count} machines' randomness`, ms: Math.round(performance.now() - started), ok, detail: JSON.stringify(seen) })
  return { steps, conversation: "" }
}

/**
 * The move a quit or a sleep made of the Thread `asked` was in: its plan, once it has started where it lands or stopped.
 * The plans are this host's own record of every move (`<data root>/cloud/moves`).
 */
async function handedOffBy(asked: string, why: "quit" | "sleep", timeoutMs: number): Promise<string> {
  const folder = join(dataRoot, "cloud", "moves")
  const PlanSchema = z.object({ move: z.string(), asked: z.string(), phase: z.string(), reason: z.string().optional(), handingOff: z.object({ why: z.string() }).loose().optional() }).loose()
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 500))) {
    for (const name of await readdir(folder).catch(() => [])) {
      if (!name.endsWith(".json")) continue
      const plan = PlanSchema.safeParse(JSON.parse(await readFile(join(folder, name), "utf8").catch(() => "null"))).data
      if (plan?.asked !== asked || plan.handingOff?.why !== why) continue
      if (plan.phase === "started") return plan.move
      if (plan.phase === "kept-here") throw new Error(`the ${why} handoff ended ${plan.phase}: ${plan.reason ?? ""}`)
    }
  }
  throw new Error(`no ${why} handoff started within ${timeoutMs / 1000} s`)
}

/**
 * Quits the app as a person does, in its window: Cmd+Q (the window's own keyboard layer runs the quit command the
 * app menu's Quit sends it), then, once the sheet offers it, a click on "Hand off to the cloud and quit". Trusted input
 * through the window's DevTools socket, so the person's own windows keep their focus. Answers when the window closed.
 */
async function quitThroughWindow(): Promise<string> {
  if (!values.devtools) throw new Error("--handoff-by quit needs --devtools, the window's DevTools page socket")
  const socket = new WebSocket(values.devtools)
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
  const closed = new Promise<number>((resolve) => socket.once("close", () => resolve(performance.now())))
  let next = 0
  const ReplySchema = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.unknown().optional() }).loose()
  const pending = new Map<number, (message: z.infer<typeof ReplySchema>) => void>()
  socket.on("message", (data: Buffer) => {
    const message = ReplySchema.parse(JSON.parse(data.toString()))
    if (message.id) pending.get(message.id)?.(message)
  })
  type Params = Record<string, string | number | boolean>
  const command = (method: string, params: Params = {}) => new Promise<unknown>((resolve, reject) => {
    const sent = ++next
    pending.set(sent, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)))
    socket.send(JSON.stringify({ id: sent, method, params }))
  })
  const evaluate = async (expression: string) => z.object({ result: z.object({ value: z.unknown().optional() }).loose() }).loose().parse(await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value
  const shot = async (name: string) => {
    const { data } = z.object({ data: z.string() }).parse(await command("Page.captureScreenshot", { format: "png" }))
    const path = join(dirname(values.report ?? join(tmpdir(), "x")), `quit-${name}.png`)
    await writeFile(path, Buffer.from(data, "base64"))
    return path
  }
  for (const type of ["keyDown", "keyUp"]) await command("Input.dispatchKeyEvent", { type, modifiers: 4, key: "q", code: "KeyQ", windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81 })
  const asked = performance.now()
  // The sheet offers the handoff once it has asked which Threads at work can go.
  let rect: { x: number; y: number } | undefined
  for (const deadline = Date.now() + 30_000; !rect && Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 100)))
    rect = z.object({ x: z.number(), y: z.number() }).optional().parse(await evaluate(`(() => { const b = document.querySelector("[data-handoff-action]"); if (!b || b.disabled) return undefined; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`))
  if (!rect) throw new Error(`the quit sheet offered no handoff (${await shot("sheet")})`)
  const offered = performance.now()
  const sheet = await shot("sheet")
  for (const type of ["mousePressed", "mouseReleased"]) await command("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 })
  const clicked = performance.now()
  await new Promise((resolve) => setTimeout(resolve, 300))
  const going = await shot("handing-off").catch(() => "the window had closed")
  const gone = await Promise.race([closed, new Promise<undefined>((resolve) => setTimeout(resolve, 120_000))])
  if (gone === undefined) throw new Error(`the window didn't close within two minutes of the click (${await shot("stuck")})`)
  return `Cmd+Q to the sheet's offer ${((offered - asked) / 1000).toFixed(1)} s, click to the window closed ${((gone - clicked) / 1000).toFixed(1)} s; ${sheet}, ${going}`
}

/** What the proof's app prints of the value it read: a hash, never the value. */
const valueHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16)

/** The app a carried-files proof runs: it reads `.env` itself, as an app's own loader does, and says only a hash of it. */
const CARRY_PROOF_APP = `import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
let value
try {
  value = /^CARRY_PROOF_TOKEN=(.*)$/m.exec(readFileSync(".env", "utf8"))?.[1]
} catch {}
console.log(value ? \`carry-proof sha256 \${createHash("sha256").update(value).digest("hex").slice(0, 16)}\` : "carry-proof missing")
createServer((_request, response) => response.end("ok")).listen(Number(process.env.PORT))
`

/**
 * A project's carried files on a move (\`--carried\`): its recipe carries \`.env\` and names the secret its app reads.
 * Copied to the account's store with the person's word, it reaches the machine before the app starts there; back
 * here it's as it was; changed here, the next move's machine has the new one; removed from the cloud in Settings, the
 * next start there says it's missing.
 */
async function carriedProof(harness: string, project: string): Promise<Proved> {
  const steps: Step[] = []
  const id = randomUUID()
  const answered: string[] = []
  const timed = async (step: string, work: () => Promise<string | undefined>) => {
    const started = performance.now()
    try {
      const detail = await work()
      const done: Step = { step, ms: Math.round(performance.now() - started), ok: true }
      if (detail) done.detail = detail
      steps.push(done)
    } catch (error) {
      steps.push({ step, ms: Math.round(performance.now() - started), ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
    const last = steps.at(-1)!
    console.log(`${"carried".padEnd(9)} ${step.padEnd(30)} ${last.ok ? "ok  " : "FAIL"} ${String(last.ms).padStart(7)} ms  ${last.detail ?? ""}`)
    return last.ok
  }
  const proved = (): Proved => ({ steps, conversation: id })
  const dummies = [`carry-proof-${randomUUID()}`, `carry-proof-${randomUUID()}`]
  if (values.report) await writeFile(join(dirname(values.report), "carried-values.txt"), `${dummies.join("\n")}\n`, { mode: 0o600 })
  const envLine = (value: string) => `# the proof's dummy secret\nCARRY_PROOF_TOKEN=${value}\n`
  let folder = ""
  let booted = false

  if (!(await timed("a project carrying .env", async () => {
    await mkdir(join(project, ".mako"), { recursive: true })
    await writeFile(join(project, ".mako", "recipe.json"), `${JSON.stringify({ processes: { web: { command: "node carry-proof-app.mjs", port: "{port}" } }, carry: [".env"], secretNames: ["CARRY_PROOF_TOKEN"] }, null, 2)}\n`)
    await writeFile(join(project, "carry-proof-app.mjs"), CARRY_PROOF_APP)
    await git(project, "add", ".mako/recipe.json", "carry-proof-app.mjs")
    await git(project, "-c", "user.name=Mako proof", "-c", "user.email=proof@mako.local", "commit", "-q", "-m", "carried-files proof: a recipe carrying .env, and an app reading it")
    // Ignored on this Mac alone, as a person's own exclude does: the machine's clone has no rule for it of its own.
    await writeFile(join(project, ".git", "info", "exclude"), ".env\n", { flag: "a" })
    await writeFile(join(project, ".env"), envLine(dummies[0]!), { mode: 0o600 })
    return undefined
  }))) return proved()

  if (!(await timed("start in its worktree", async () => {
    const first = randomUUID()
    const mode = widestMode(harness)
    await call("mako:live-start", [harness, project, { conversationId: id, worktree: true, ...mode && { modeId: mode }, initialRequest: { id: first, text: "Without running anything, reply with the word READY.", attachments: [] } }])
    const shot = await until(id, (current) => settled(current, first), 300_000, answered)
    folder = shot.session.cwd ?? ""
    const here = await readFile(join(folder, ".env"), "utf8")
    if (here !== envLine(dummies[0]!)) throw new Error("the worktree's .env isn't the main checkout's")
    return "the worktree got .env from the main checkout, as the recipe carries it"
  }))) return proved()

  const CarriedSchema = z.object({ decision: z.string(), files: z.array(z.object({ path: z.string(), cloud: z.object({ current: z.boolean() }).nullable(), kept: z.boolean() }).loose()) }).loose()
  // Every step after needs `.env` in the account's store: one that failed ends the proof with its report.
  if (!(await timed("asked, then allowed", async () => {
    const before = CarriedSchema.parse(await call("mako:cloud-carried-files", [folder]))
    // What a project carries is its recipe's list, and a recipe the account keeps for the repository outranks the one
    // committed here (the account's syncs down by the first read after sign-in): then this proof's isn't in force.
    if (!before.files.some((file) => file.path === ".env"))
      throw new Error(`the recipe in force isn't this proof's: it carries ${before.files.map((file) => file.path).join(", ") || "nothing"}, not .env. The account keeps a recipe for ${values.repository}, which outranks the project's committed .mako/recipe.json; run the proof with --repository naming one the account keeps no recipe for`)
    if (before.decision !== "unasked" || before.files.some((file) => file.cloud)) throw new Error(`before the person's word: ${JSON.stringify(before)}`)
    const after = CarriedSchema.parse(await call("mako:cloud-carried-files-decide", [folder, true]))
    if (after.files.find((file) => file.path === ".env")?.cloud?.current !== true) throw new Error(`after it: ${JSON.stringify(after)}`)
    return ".env in the account's store"
  }))) return proved()

  /** Moves the Thread, opens its folder in this run's tab, and starts its app there; answers the app's first line, or why it didn't start. */
  const moveAndStart = async (): Promise<{ problems: string[]; line: string }> => {
    const outcome = OutcomeSchema.parse(await call("mako:thread-move", [id, randomUUID()]))
    if (outcome.kind !== "moved") throw new Error(`the move: ${outcome.kind}: ${outcome.reason}`)
    // This run's own tab, opened on the moved folder: its app calls go to the machine, as a window's do.
    if (!booted) booted = Boolean(await call("mako:boot", []))
    await call("mako:set-cwd", [folder, id])
    // A start the recipe's named secrets refuse throws, saying which; the proof reads it as the window shows it.
    const started = await call("mako:thread-app-start", [folder]).then(
      (answer) => z.object({ problems: z.array(z.string()) }).parse(answer).problems,
      (error: Error) => [error.message],
    )
    if (started.length) return { problems: started, line: "" }
    for (const deadline = Date.now() + 120_000; ; await new Promise((resolve) => setTimeout(resolve, 500))) {
      const output = z.object({ text: z.string() }).loose().parse(await call("mako:thread-app-output", [folder, "process:web"]))
      const line = /carry-proof (sha256 [0-9a-f]{16}|missing)/.exec(output.text)?.[0]
      if (line) {
        await call("mako:thread-app-stop", [folder])
        return { problems: [], line }
      }
      if (Date.now() > deadline) throw new Error(`the app said nothing of .env within two minutes: ${output.text.slice(-300)}`)
    }
  }
  const back = async () => {
    const outcome = ReturnOutcomeSchema.parse(await call("mako:thread-return", [id, randomUUID()]))
    if (outcome.kind !== "back") throw new Error(`the way back: ${JSON.stringify(outcome)}`)
    await call("mako:set-cwd", [folder])
  }

  if (!(await timed("moved, its app reads .env", async () => {
    const { problems, line } = await moveAndStart()
    if (problems.length) throw new Error(`the app didn't start: ${problems.join("; ")}`)
    if (line !== `carry-proof sha256 ${valueHash(dummies[0]!)}`) throw new Error(`the app read another value: ${line}`)
    return line
  }))) return proved()

  if (!(await timed("back, .env unchanged", async () => {
    await back()
    const info = await lstat(join(folder, ".env"))
    if (!info.isFile()) throw new Error("the worktree's .env isn't a file of its own any more")
    if ((await readFile(join(folder, ".env"), "utf8")) !== envLine(dummies[0]!)) throw new Error("the worktree's .env changed on the way back")
    return "the same file, the same value"
  }))) return proved()

  if (!(await timed("changed here, moved again", async () => {
    await writeFile(join(project, ".env"), envLine(dummies[1]!))
    const { problems, line } = await moveAndStart()
    if (problems.length) throw new Error(`the app didn't start: ${problems.join("; ")}`)
    if (line !== `carry-proof sha256 ${valueHash(dummies[1]!)}`) throw new Error(`the machine has an older value: ${line}`)
    await back()
    return line
  }))) return proved()

  await timed("removed in Settings, missing", async () => {
    const kept = CarriedSchema.parse(await call("mako:cloud-carried-files-keep", [folder, ".env", true]))
    if (!kept.files.find((file) => file.path === ".env")?.kept) throw new Error(`not kept here: ${JSON.stringify(kept)}`)
    const { problems, line } = await moveAndStart()
    if (!problems.some((problem) => problem.includes("no value for CARRY_PROOF_TOKEN"))) throw new Error(`the start didn't say it's missing: ${problems.join("; ") || line}`)
    await back()
    return problems.join("; ").slice(0, 240)
  })
  return proved()
}

/**
 * A model a turn handed to a machine with no sign-ins can go on with: for OpenCode, one of its free models
 * (`MAKO_OPENCODE_MODEL` choosing), its default first. Undefined for other harnesses: their own default.
 */
async function freeModel(harness: string, cwd: string): Promise<string | undefined> {
  if (harness !== "opencode") return undefined
  if (process.env.MAKO_OPENCODE_MODEL) return process.env.MAKO_OPENCODE_MODEL
  const profile = z.object({ models: z.array(z.object({ id: z.string() }).loose()).default([]), defaultModel: z.string().optional() }).loose().parse(await call("mako:harness-tuning", [harness, cwd]))
  const free = profile.models.map((model) => model.id).filter((id) => id.startsWith("opencode/") && id.endsWith("-free"))
  return free.find((id) => id === profile.defaultModel) ?? free[0]
}

// A clone of the repository as a person's project: the Threads take worktrees of it. A host of its own keeps it in its
// data root, for as long as the worktrees made of it: a Thread the run leaves in the cloud comes back into its worktree
// later, which needs its project, and the data root goes whole when it's cleaned up.
const projects = join(dataRoot, "proof-projects")
await mkdir(projects, { recursive: true, mode: 0o700 })
const scratch = await mkdtemp(join(projects, "mako-move-proof-"))
const project = join(scratch, "project")
await run("git", ["clone", "-q", values.repository, project])
const report: Record<string, Awaited<ReturnType<typeof prove>>> = {}
for (const harness of HARNESSES) report[harness] = await prove(harness, project)
const places = values["full-cloud"] === undefined ? 0 : Number(values["full-cloud"])
// Any Thread that's here again (back from the cloud, or kept here) moves no differently.
const here = Object.values(report).find(({ steps }) => steps.some((step) => (step.step === "back to this Mac" || step.step === "runs here after the refusal") && step.ok))?.conversation
if (places > 0 && here) report["full cloud"] = await fullCloud(places, here)
if (values.handoff) report["handoff"] = await handOffProof(values.handoff, project)
if (values["fork-burst"]) report["fork burst"] = await forkBurst(values["tab-harness"] ?? "claude", project, Number(values["fork-burst"]))
if (values.entropy) report["entropy"] = await entropy(values["tab-harness"] ?? "claude", project, Number(values.entropy))
if (values.carried) report["carried"] = await carriedProof(values.carried, project)
if (values["project-gone"]) report["project gone"] = await projectGoneProof(values["project-gone"])
if (values.archive) report["archive"] = await archiveProof(values.archive)
// A host this run started signs out as it ends: its device leaves the account, and its credential leaves the keychain.
if (values["spawn-host"]) await call("mako:cloud-sign-out", [])
if (values.report) await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`)

const stepNames = [...new Set(Object.values(report).flatMap(({ steps }) => steps.map((step) => step.step)))]
console.log(`\n${["harness", ...stepNames.map((name) => name.split(" ").slice(0, 3).join(" "))].map((name) => name.padEnd(16)).join(" ")}`)
for (const [harness, { steps }] of Object.entries(report))
  console.log([harness, ...stepNames.map((name) => {
    const step = steps.find((entry) => entry.step === name)
    return step ? `${step.ok ? "" : "✗ "}${(step.ms / 1000).toFixed(1)} s` : "–"
  })].map((cell) => cell.padEnd(16)).join(" "))
const failed = Object.entries(report).flatMap(([harness, { steps }]) => steps.filter((step) => !step.ok).map((step) => `${harness}: ${step.step}: ${step.detail}`))
console.log(`\nProject (kept for the Threads left in the cloud): ${project}`)
console.log(`Threads (conversation ids): ${Object.entries(report).map(([harness, { conversation }]) => `${harness} ${conversation}`).join(", ")}`)
console.log(failed.length ? `\n${failed.length} step${failed.length === 1 ? "" : "s"} failed:\n${failed.join("\n")}` : "\nEvery step passed on every harness.")
process.exit(failed.length ? 1 : 0)
