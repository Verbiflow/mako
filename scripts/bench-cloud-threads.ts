import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import type { LiveStartOptions } from "@mako/host/contracts/live-conversations"
import { invokeRuntime } from "@mako/host/transport/connection"
import { appDataFolder, runtimeDataRoot, runtimeLocation } from "@mako/host/transport/service"

/**
 * How a cloud Thread feels, timed from this Mac's own host through the calls the composer makes, on each harness,
 * beside the same steps run locally. For each: the start until the first output and the reply; a message while it's
 * awake; a message after it has slept (its machine pauses two minutes after its work ends), with the composer's
 * warm-up as the person starts typing and without; and the close. With `--ahead-ms`, a second start whose Thread the
 * composer made ahead while the person wrote for that long (`mako:cloud-prepare`, asked every 30 s). Prints a table
 * and writes a JSON report; prints no secret.
 *
 *   npx tsx scripts/bench-cloud-threads.ts [--harness claude …] [--repository <url>] [--local] [--no-warm] [--ahead-ms 20000] [--report <file>]
 */
const { values } = parseArgs({
  options: {
    harness: { type: "string", multiple: true },
    repository: { type: "string", default: "https://github.com/octocat/Hello-World" },
    local: { type: "boolean", default: false },
    "no-warm": { type: "boolean", default: false },
    /** How long the person types before sending, after the warm-up: the time the machine has to wake. */
    "typing-ms": { type: "string", default: "3000" },
    /** How long the person writes a new cloud Thread's first message while its Thread is made ahead; none, no such start. */
    "ahead-ms": { type: "string" },
    report: { type: "string" },
  },
})
const HARNESSES = values.harness?.length ? values.harness : ["claude", "codex", "cursor", "opencode", "grok", "devin"]
const TYPING_MS = Number(values["typing-ms"])
/** Its machine pauses two minutes after its work ends; this waits that out with room to spare. */
const SLEEP_MS = 150_000
const { socket } = runtimeLocation(runtimeDataRoot(appDataFolder(), {}))
const client = randomUUID()
const call = (channel: string, args: unknown[]) => invokeRuntime(socket, client, channel, args)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const DescriptorSchema = z.array(z.object({ provider: z.string(), modes: z.array(z.object({ id: z.string(), access: z.string().optional() }).loose()).default([]) }).loose())
const descriptors = DescriptorSchema.parse(await call("mako:harness-descriptors", []))
/** Nothing to approve in a benchmark: the mode that asks least. */
const fullMode = (harness: string) => {
  const modes = descriptors.find((descriptor) => descriptor.provider === harness)?.modes ?? []
  return (modes.find((mode) => mode.access === "full") ?? modes.find((mode) => mode.access === "auto"))?.id
}
const SnapshotSchema = z.object({ requests: z.array(z.object({ id: z.string(), status: z.string() }).loose()).default([]), blocks: z.array(z.object({ type: z.string() }).loose()).default([]) }).loose()
type Snapshot = z.infer<typeof SnapshotSchema>
const snapshot = async (id: string) => SnapshotSchema.parse(await call("mako:live-snapshot", [id]))
const status = (shot: Snapshot, request: string) => shot.requests.find((entry) => entry.id === request)?.status
const settled = (value: string | undefined) => value !== undefined && !["queued", "dispatching", "running", "pending"].includes(value)
/** The composer's warm-up as the person types (`noteComposing`), unless asked to leave it out. */
const canWarm = !values["no-warm"]

/** First output: the first block the agent wrote after the prompt's; then the reply settled. */
async function timeTurn(id: string, request: string, before: number, sentAt: number) {
  let firstMs: number | undefined
  for (;;) {
    const shot = await snapshot(id).catch(() => undefined)
    if (shot) {
      if (firstMs === undefined && shot.blocks.length > before + 1) firstMs = performance.now() - sentAt
      const state = status(shot, request)
      if (settled(state)) return { firstMs: firstMs ?? performance.now() - sentAt, replyMs: performance.now() - sentAt, ok: state === "completed", blocks: shot.blocks.length }
    }
    if (performance.now() - sentAt > 300_000) return { firstMs, replyMs: undefined, ok: false, blocks: before }
    await pause(100)
  }
}

type Turn = Awaited<ReturnType<typeof timeTurn>>
type Result = { harness: string; place: "cloud" | "local"; start?: Turn; ahead?: Turn; awake?: Turn; asleep?: Turn; warmed?: Turn; closeMs?: number; problem?: string }

/** The composer asks again this often while the person writes (`PREWARM_EVERY_MS`). */
const ASK_EVERY_MS = 30_000

/** A new cloud Thread's start after `aheadMs` of writing, its Thread made ahead as the composer does it. */
async function aheadStart(harness: string, cwd: string, aheadMs: number): Promise<Turn> {
  const id = randomUUID()
  const first = randomUUID()
  const began = performance.now()
  for (let asked = 0; asked < aheadMs; asked += ASK_EVERY_MS) {
    await pause(began + asked - performance.now())
    await call("mako:cloud-prepare", [cwd, asked])
  }
  await pause(began + aheadMs - performance.now())
  const options: LiveStartOptions = { conversationId: id, initialRequest: { id: first, attachments: [], text: "Reply with the single word ONE." }, cloud: {} }
  const mode = fullMode(harness)
  if (mode) options.modeId = mode
  const sentAt = performance.now()
  await call("mako:live-start", [harness, cwd, options])
  const turn = await timeTurn(id, first, 0, sentAt)
  await call("mako:live-close", [id]).catch(() => undefined)
  return turn
}

async function bench(harness: string, place: "cloud" | "local", cwd: string): Promise<Result> {
  const result: Result = { harness, place }
  const id = randomUUID()
  const mode = fullMode(harness)
  try {
    const first = randomUUID()
    const options: LiveStartOptions = {
      conversationId: id,
      initialRequest: { id: first, attachments: [], text: "Reply with the single word ONE." },
    }
    if (mode) options.modeId = mode
    if (place === "cloud") options.cloud = { repository: { url: values.repository } }
    let sentAt = performance.now()
    await call("mako:live-start", [harness, cwd, options])
    result.start = await timeTurn(id, first, 0, sentAt)
    const send = async (text: string) => {
      const before = (await snapshot(id)).blocks.length
      const request = randomUUID()
      sentAt = performance.now()
      await call("mako:live-prompt", [id, request, text, []])
      return timeTurn(id, request, before, sentAt)
    }
    result.awake = await send("Reply with the single word TWO.")
    if (place === "cloud") {
      await pause(SLEEP_MS)
      result.asleep = await send("Reply with the single word THREE.")
      if (canWarm) {
        await pause(SLEEP_MS)
        // The composer warms the conversation at the first keystroke (`noteComposing`), not waiting on it; the
        // person sends a moment later.
        void call("mako:live-prewarm", [id]).catch(() => undefined)
        await pause(TYPING_MS)
        result.warmed = await send("Reply with the single word FOUR.")
      }
    }
    const closing = performance.now()
    await call("mako:live-close", [id])
    result.closeMs = performance.now() - closing
    if (place === "cloud" && values["ahead-ms"]) result.ahead = await aheadStart(harness, cwd, Number(values["ahead-ms"]))
  } catch (error) {
    result.problem = error instanceof Error ? error.message : String(error)
    await call("mako:live-close", [id]).catch(() => undefined)
  }
  console.log(`${harness.padEnd(9)} ${place.padEnd(6)} ${result.problem ? `✗ ${result.problem.slice(0, 120)}` : "done"}`)
  return result
}

const cwd = await mkdtemp(join(tmpdir(), "mako-bench-cloud-"))
// The folder the composer writes in: a clone of nothing, whose origin names the repository the cloud clones.
execFileSync("git", ["init", "-q", cwd])
execFileSync("git", ["-C", cwd, "remote", "add", "origin", values.repository])
let results: Result[] = []
try {
  results = await Promise.all(HARNESSES.flatMap((harness) => [bench(harness, "cloud", cwd), ...(values.local ? [bench(harness, "local", cwd)] : [])]))
} finally {
  await rm(cwd, { recursive: true, force: true })
}
if (values.report) await writeFile(values.report, `${JSON.stringify({ at: new Date().toISOString(), repository: values.repository, typingMs: TYPING_MS, aheadMs: values["ahead-ms"] === undefined ? undefined : Number(values["ahead-ms"]), warm: canWarm, results }, null, 2)}\n`)
const s = (ms: number | undefined) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(1)} s`)
const turn = (value: Turn | undefined) => (value ? `${value.ok ? "" : "✗ "}${s(value.firstMs)} / ${s(value.replyMs)}` : "–")
console.log(`\nfirst output / reply`)
console.log(["harness", "place", "start", "start, made ahead", "awake", "after sleep", `warmed, ${TYPING_MS / 1000} s typing`, "close"].map((name) => name.padEnd(18)).join(""))
for (const result of results.sort((a, b) => a.harness.localeCompare(b.harness) || a.place.localeCompare(b.place)))
  console.log([result.harness, result.place, turn(result.start), turn(result.ahead), turn(result.awake), turn(result.asleep), turn(result.warmed), s(result.closeMs)].map((cell) => cell.padEnd(18)).join(""))
