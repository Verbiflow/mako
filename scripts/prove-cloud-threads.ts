import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { invokeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { assertOwnHarnessStores, proofDataRoot } from "./lib/proof-host.ts"

/**
 * 1.8's live proof: a cloud Thread from a host of this Mac's, through the calls the composer and the transcript make,
 * on each harness. It starts the Thread on a public GitHub repository, watches it, answers its permission request,
 * steers it while it runs, stops a turn, and reads a turn back that finished while nothing here watched. Every step
 * is timed; each conversation is closed at the end. Prints no secret; writes a JSON report.
 *
 *   npx tsx scripts/prove-cloud-threads.ts --data-root <dir> [--harness claude --harness codex …] [--report <file>]
 *
 * Only on a host of its own (`--data-root`: a packaged app's scratch profile, `PackagedApp`), never this Mac's own Mako,
 * whose sidebar its Threads would join; the run checks the host's harnesses run in a home of their own.
 */
const { values } = parseArgs({
  options: {
    harness: { type: "string", multiple: true },
    repository: { type: "string", default: "https://github.com/octocat/Hello-World" },
    report: { type: "string" },
    "data-root": { type: "string" },
  },
})
const HARNESSES = values.harness?.length ? values.harness : ["claude", "codex", "cursor", "opencode", "grok", "devin"]
const dataRoot = proofDataRoot(values["data-root"], "the cloud Threads proof")
const { socket } = runtimeLocation(dataRoot)
const client = randomUUID()
const call = (channel: string, args: unknown[]) => invokeRuntime(socket, client, channel, args)
await assertOwnHarnessStores(call, dataRoot)

/** Each harness's own modes, as the composer reads them: the start asks first where the harness has a mode that asks. */
const DescriptorSchema = z.array(z.object({ provider: z.string(), modes: z.array(z.object({ id: z.string(), access: z.string().optional() }).loose()).default([]) }).loose())
const descriptors = DescriptorSchema.parse(await call("mako:harness-descriptors", []))
const askingMode = (harness: string) => {
  const modes = descriptors.find((descriptor) => descriptor.provider === harness)?.modes ?? []
  return (modes.find((mode) => mode.access === "ask") ?? modes.find((mode) => mode.access === "edits"))?.id
}

const RequestSchema = z.object({ id: z.string(), status: z.string() }).loose()
const OptionSchema = z.object({ optionId: z.string(), kind: z.string().optional(), name: z.string().optional() }).loose()
const PermissionSchema = z.object({ id: z.string(), options: z.array(OptionSchema).default([]) }).loose()
const SnapshotSchema = z.object({
  session: z.object({ status: z.string() }).loose(),
  /** What the agent waits on the person for: a snapshot's own, beside the session. */
  permissions: z.array(PermissionSchema).default([]),
  requests: z.array(RequestSchema).default([]),
  blocks: z.array(z.object({ type: z.string() }).loose()).default([]),
}).loose()
type Snapshot = z.infer<typeof SnapshotSchema>

const snapshot = async (id: string): Promise<Snapshot> => SnapshotSchema.parse(await call("mako:live-snapshot", [id]))
/** The words of the blocks the agent wrote after `from`. */
const replyText = (shot: Snapshot, from: number) =>
  shot.blocks.slice(from).filter((block) => block.type === "text").map((block) => z.object({ text: z.string() }).loose().safeParse(block).data?.text ?? "").join(" ")
const settled = (shot: Snapshot, request: string) => {
  const found = shot.requests.find((entry) => entry.id === request)
  return found !== undefined && !["queued", "dispatching", "running", "pending"].includes(found.status)
}

type Step = { step: string; ms: number; ok: boolean; detail?: string }
/** What `mako:live-start` reads for a cloud Thread, as the composer sends it. */
type StartOptions = {
  conversationId: string
  modeId?: string
  initialRequest: { id: string; text: string; attachments: [] }
  cloud: { repository: { url: string } }
}

/** Waits on the conversation, answering every permission request with its first allowing option, until `done`. */
async function until(id: string, done: (shot: Snapshot) => boolean, timeoutMs: number, answered: string[]): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const shot = await snapshot(id)
    for (const permission of shot.permissions) {
      if (answered.includes(permission.id)) continue
      // Once, never a rule the harness would keep: the proof leaves no lasting permission behind.
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

async function prove(harness: string, cwd: string): Promise<Step[]> {
  const steps: Step[] = []
  const id = randomUUID()
  const answered: string[] = []
  const timed = async (step: string, run: () => Promise<string | undefined>) => {
    const started = performance.now()
    try {
      const done: Step = { step, ms: Math.round(performance.now() - started), ok: true }
      const detail = await run()
      done.ms = Math.round(performance.now() - started)
      if (detail) done.detail = detail
      steps.push(done)
    } catch (error) {
      steps.push({ step, ms: Math.round(performance.now() - started), ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
    console.log(`${harness.padEnd(9)} ${step.padEnd(28)} ${steps.at(-1)!.ok ? "ok  " : "FAIL"} ${String(steps.at(-1)!.ms).padStart(7)} ms  ${steps.at(-1)!.detail ?? ""}`)
    return steps.at(-1)!.ok
  }
  const first = randomUUID()
  // Start: the Thread on a machine, in a clone of the repository, asking before it runs a command.
  if (!(await timed("start", async () => {
    const options: StartOptions = {
      conversationId: id,
      initialRequest: { id: first, text: "Run the shell command `sleep 15 && echo slept` in the repository, then reply with one short sentence that includes the word DONE.", attachments: [] },
      cloud: { repository: { url: values.repository } },
    }
    // Asking first, where the harness has a mode that asks (Cursor's one tier is full access); Codex's own reviewer
    // may answer for the person, so a harness can finish with no permission asked.
    const mode = askingMode(harness)
    if (mode) options.modeId = mode
    await call("mako:live-start", [harness, cwd, options])
    return `mode ${mode ?? "its one"}`
  }))) return steps
  // Watch, answer and steer: the first output, the permission answered, a message steered into the running turn.
  await timed("first output", async () => {
    const shot = await until(id, (current) => current.blocks.length > 1 || settled(current, first), 240_000, answered)
    return `${shot.blocks.length} blocks`
  })
  const steer = randomUUID()
  await timed("steer while running", async () => {
    await call("mako:live-prompt", [id, steer, "Also include the word BLUE in your final reply.", []])
    return undefined
  })
  await timed("reply, steered and answered", async () => {
    const shot = await until(id, (current) => settled(current, first) && settled(current, steer), 300_000, answered)
    const text = replyText(shot, 0)
    if (!/DONE/i.test(text)) throw new Error(`no DONE in the reply: ${text.slice(0, 160)}`)
    return `${answered.length} permission${answered.length === 1 ? "" : "s"} answered; BLUE ${/BLUE/i.test(text) ? "in the reply" : "not in the reply"}`
  })
  // Stop: a long command, cancelled once it runs. Not `sleep`: Claude Code refuses a standalone one.
  const long = randomUUID()
  await timed("stop", async () => {
    await call("mako:live-prompt", [id, long, "Run the shell command `node -e \"setTimeout(() => console.log(1), 300000)\"` in the repository, in the foreground and not in the background, then reply with the word LATE.", []])
    // A request reads `dispatching` from its send until it settles; once the harness has begun on it (a block past
    // what was there), the command is running.
    const before = (await snapshot(id)).blocks.length
    await until(id, (current) => ["dispatching", "running"].includes(current.requests.find((request) => request.id === long)?.status ?? "") && current.blocks.length > before + 1, 120_000, answered)
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    const asked = performance.now()
    await call("mako:live-cancel", [id])
    const shot = await until(id, (current) => settled(current, long), 60_000, answered)
    const status = shot.requests.find((request) => request.id === long)?.status
    if (status === "completed") throw new Error("the turn finished instead of stopping")
    return `settled ${status} ${Math.round(performance.now() - asked)} ms after the stop`
  })
  // Away: a turn that finishes while this client watches nothing, read back afresh.
  const away = randomUUID()
  await timed("finished while away", async () => {
    const before = (await snapshot(id)).blocks.length
    await call("mako:live-prompt", [id, away, "Reply with exactly the word AWAY.", []])
    await new Promise((resolve) => setTimeout(resolve, 45_000))
    const shot = await until(id, (current) => settled(current, away), 120_000, answered)
    const text = replyText(shot, before)
    if (!/AWAY/i.test(text)) throw new Error(`no AWAY: ${text.slice(0, 160)}`)
    return undefined
  })
  await timed("close", async () => {
    await call("mako:live-close", [id])
    return undefined
  })
  return steps
}

const cwd = await mkdtemp(join(tmpdir(), "mako-cloud-proof-"))
const report: Record<string, Step[]> = {}
try {
  for (const harness of HARNESSES) report[harness] = await prove(harness, cwd)
} finally {
  await rm(cwd, { recursive: true, force: true })
}
if (values.report) await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`)
// The timings side by side: a column per step, a row per harness.
const stepNames = [...new Set(Object.values(report).flatMap((steps) => steps.map((step) => step.step)))]
console.log(`\n${["harness", ...stepNames].map((name) => name.padEnd(14)).join(" ")}`)
for (const [harness, steps] of Object.entries(report))
  console.log([harness, ...stepNames.map((name) => {
    const step = steps.find((entry) => entry.step === name)
    return step ? `${step.ok ? "" : "✗ "}${(step.ms / 1000).toFixed(1)} s` : "–"
  })].map((cell) => cell.padEnd(14)).join(" "))
const failed = Object.entries(report).flatMap(([harness, steps]) => steps.filter((step) => !step.ok).map((step) => `${harness}: ${step.step}: ${step.detail}`))
console.log(failed.length ? `\n${failed.length} step${failed.length === 1 ? "" : "s"} failed:\n${failed.join("\n")}` : "\nEvery step passed on every harness.")
process.exit(failed.length ? 1 : 0)
