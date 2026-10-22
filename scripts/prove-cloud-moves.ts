import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { parseArgs } from "node:util"
import { z } from "zod"
import { invokeRuntime } from "@mako/host/transport/connection"
import { appDataFolder, runtimeDataRoot, runtimeLocation } from "@mako/host/transport/service"

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
 * Prints no secret; writes a JSON report. The Threads stay, on their cloud machines, to be looked at.
 *
 *   npx tsx scripts/prove-cloud-moves.ts [--harness claude --harness codex …] [--report <file>]
 */
const { values } = parseArgs({
  options: {
    harness: { type: "string", multiple: true },
    repository: { type: "string", default: "https://github.com/octocat/Hello-World" },
    report: { type: "string" },
  },
})
const HARNESSES = values.harness?.length ? values.harness : ["claude", "codex", "cursor", "opencode", "grok", "devin"]
const dataRoot = runtimeDataRoot(appDataFolder(), {})
const { socket } = runtimeLocation(dataRoot)
const client = randomUUID()
const call = (channel: string, args: unknown[]) => invokeRuntime(socket, client, channel, args)
const run = promisify(execFile)
const git = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, ...args]).then(({ stdout }) => stdout.trim())

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

const RequestSchema = z.object({ id: z.string(), status: z.string() }).loose()
const OptionSchema = z.object({ optionId: z.string(), kind: z.string().optional(), name: z.string().optional() }).loose()
const PermissionSchema = z.object({ id: z.string(), options: z.array(OptionSchema).default([]) }).loose()
const SnapshotSchema = z.object({
  session: z.object({ status: z.string(), cwd: z.string().nullish(), nativeId: z.string().nullish() }).loose(),
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
const PlanTimingsSchema = z.object({ phase: z.string(), cloudThread: z.string(), folder: z.string(), timings: z.record(z.string(), z.number()), checkpoint: z.object({ bytes: z.number() }).loose().optional() }).loose()

const snapshot = async (id: string): Promise<Snapshot> => SnapshotSchema.parse(await call("mako:live-snapshot", [id]))
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
type StartOptions = { conversationId: string; worktree: true; modeId?: string; initialRequest: { id: string; text: string; attachments: [] } }
type Proved = { steps: Step[]; conversation: string; timings?: Record<string, number> }

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
    if (!folder.includes("/.mako/worktrees/")) throw new Error(`not in a Thread worktree: ${folder}`)
    const written = (await readFile(join(folder, "move-proof.txt"), "utf8")).trim()
    if (written !== token) throw new Error(`move-proof.txt holds ${JSON.stringify(written.slice(0, 80))}`)
    return `${folder.replace(/^.*\/\.mako\/worktrees\//, "~/.mako/worktrees/")}, mode ${mode ?? "its one"}`
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
    if (status !== "completed") throw new Error(`the turn didn't finish here after the refused move: ${status}`)
    return outcome.reason
  })

  // 4. The move, then the same move asked again.
  const move = randomUUID()
  let cloudThread = ""
  if (!(await timed("move to the cloud", async () => {
    const outcome = OutcomeSchema.parse(await call("mako:thread-move", [id, move]))
    if (outcome.kind !== "moved") throw new Error(`${outcome.kind}: ${outcome.reason}`)
    cloudThread = outcome.cloudThread
    const plan = PlanTimingsSchema.parse(JSON.parse(await readFile(join(dataRoot, "cloud", "moves", `${move}.json`), "utf8")))
    timings = plan.timings
    if (plan.phase !== "started") throw new Error(`the plan reads ${plan.phase}`)
    const order = ["made", "ahead", "released", "sent", "arrived", "claimed", "started"]
    return `${cloudThread}; ${order.filter((name) => name in plan.timings).map((name) => `${name} ${(plan.timings[name]! / 1000).toFixed(1)} s`).join(", ")}; checkpoint ${plan.checkpoint ? `${(plan.checkpoint.bytes / 1024).toFixed(0)} KiB` : "?"}`
  }))) return proved()
  await timed("the same move again", async () => {
    const outcome = OutcomeSchema.parse(await call("mako:thread-move", [id, move]))
    if (outcome.kind !== "moved" || outcome.cloudThread !== cloudThread) throw new Error(`answered ${JSON.stringify(outcome)}`)
    return undefined
  })

  // 5. A turn on the machine: the same native session (memory) at the same path, with every kind of change there.
  const there = randomUUID()
  await timed("a turn in the cloud", async () => {
    const before = (await snapshot(id)).blocks.length
    await call("mako:live-prompt", [id, there, "Before running anything, write one line starting with MEMORY: followed by the exact line you wrote into move-proof.txt earlier in this conversation, from memory. Then run this shell command and show its output: `pwd; cat move-proof.txt committed.txt staged.txt; git log -1 --format=%s; git status --short`", []])
    const shot = await until(id, (current) => settled(current, there), 420_000, answered)
    const status = shot.requests.find((request) => request.id === there)?.status
    if (status !== "completed") throw new Error(`the turn ended ${status}: ${proseText(shot, before).slice(0, 200)}`)
    const prose = proseText(shot, before)
    const everything = blockText(shot, before)
    const missing = [
      [`MEMORY: ${token}`, prose.includes(token) ? "" : "the token from memory"],
      ["the Mac's path", everything.includes(folder) ? "" : `pwd ${folder}`],
      ["the agent's file", everything.includes(token) ? "" : "move-proof.txt"],
      ["the commit", everything.includes(`move proof ${committed}`) && everything.includes(committed) ? "" : "the commit"],
      ["the staged file", everything.includes(staged) ? "" : "staged.txt"],
    ].filter(([, gap]) => gap).map(([, gap]) => gap)
    if (missing.length) throw new Error(`missing ${missing.join(", ")}; said: ${prose.slice(0, 300)}`)
    return "remembered the token; path, file, commit and staged file all there"
  })
  return proved()
}

// A clone of the repository as a person's project: the Threads take worktrees of it.
const scratch = await mkdtemp(join(tmpdir(), "mako-move-proof-"))
const project = join(scratch, "project")
await run("git", ["clone", "-q", values.repository, project])
const report: Record<string, Awaited<ReturnType<typeof prove>>> = {}
for (const harness of HARNESSES) report[harness] = await prove(harness, project)
if (values.report) await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`)

const stepNames = [...new Set(Object.values(report).flatMap(({ steps }) => steps.map((step) => step.step)))]
console.log(`\n${["harness", ...stepNames.map((name) => name.split(" ").slice(0, 3).join(" "))].map((name) => name.padEnd(16)).join(" ")}`)
for (const [harness, { steps }] of Object.entries(report))
  console.log([harness, ...stepNames.map((name) => {
    const step = steps.find((entry) => entry.step === name)
    return step ? `${step.ok ? "" : "✗ "}${(step.ms / 1000).toFixed(1)} s` : "–"
  })].map((cell) => cell.padEnd(16)).join(" "))
const failed = Object.entries(report).flatMap(([harness, { steps }]) => steps.filter((step) => !step.ok).map((step) => `${harness}: ${step.step}: ${step.detail}`))
console.log(`\nThreads (conversation ids): ${Object.entries(report).map(([harness, { conversation }]) => `${harness} ${conversation}`).join(", ")}`)
console.log(failed.length ? `\n${failed.length} step${failed.length === 1 ? "" : "s"} failed:\n${failed.join("\n")}` : "\nEvery step passed on every harness.")
process.exit(failed.length ? 1 : 0)
