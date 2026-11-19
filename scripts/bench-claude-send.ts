import "./lib/scratch-git.mjs"
// How long a message the person sends waits before Claude Code asks its model, with and without its first write held
// (`WriteHolds`, `ProviderLiveDriver.firstWrite`): the real Claude Code CLI through Mako's own live driver and
// conversations, in a sealed home, against the scripted model (no account; nothing leaves this machine), on a large
// checkout another writer keeps changing, so each turn's checkpoint reads real work.
//
// One build, the feature switched: `held` gives the host's write holds to Claude's driver and the conversations, so
// the message goes at once and the first write waits; `waited` gives neither, so the message waits for its turn's
// checkpoint as every harness without a hold does. Runs alternate (ABBA) and every sample is kept. Each run records the
// machine's load average as it starts and ends (`load`): other work on the machine slows the checkpoint, and so the
// waited arm, so a loaded run says so.
//
//   npm run bench:claude-send -- [--sends 15] [--files 6000] [--churn 40] [--gap 3000] [--out <file>]
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { cpus, loadavg } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseArgs } from "node:util"
import { z } from "zod"
import { execFileSync } from "node:child_process"
import { Git } from "@mako/git"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import { installClaude } from "@mako/host/harnesses/claude/index"
import { WriteHolds } from "@mako/host/harnesses/write-holds"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { followHostLog } from "@mako/host/base/host-log"
import { admitted } from "./fixtures/admitted-start.ts"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { sandboxed } from "./harness-sandbox.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel } from "./scripted-model.ts"

const { values } = parseArgs({
  options: {
    sends: { type: "string", default: "15" },
    files: { type: "string", default: "6000" },
    churn: { type: "string", default: "40" },
    gap: { type: "string", default: "3000" },
    out: { type: "string" },
  },
})
const SENDS = Number(values.sends), FILES = Number(values.files), CHURN = Number(values.churn), GAP_MS = Number(values.gap)

type Arm = "waited" | "held"
interface RunLoad { run: string; arm: Arm; cores: number; start: number[]; end: number[] }
/** The host log's line for a turn's saved checkpoint: its request, and how long the checkpoint held the turn. */
const SavedCheckpoint = z.object({ request: z.string(), heldMs: z.number().optional() }).loose()
const reading = () => loadavg().map((value) => Math.round(value * 100) / 100)
interface Sample { tag: string; arm: Arm; run: string; modelMs: number; heldMs: number | null; before: string | undefined; reason?: string }

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? null
/** Each quantile is null when there's no sample: a run whose checkpoints never saved has no held time. */
function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return { n: sorted.length, p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), p95: quantile(sorted, 0.95), max: sorted.at(-1) ?? null }
}

await sandboxed("mako-claude-send", "claude", async (sandbox) => {
  // A checkout of `FILES` files in a few hundred folders, committed, that a writer keeps changing between and during turns.
  const project = sandbox.project
  execFileSync("git", ["init", "-q"], { cwd: project })
  execFileSync("git", ["config", "user.email", "bench@localhost"], { cwd: project })
  execFileSync("git", ["config", "user.name", "Bench"], { cwd: project })
  for (let index = 0; index < FILES; index += 1) {
    const folder = join(project, "src", `part${index % 300}`)
    if (index < 300) mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `file${index}.ts`), `export const value${index} = ${index}\n${"// filler line\n".repeat(60)}`)
  }
  execFileSync("git", ["add", "-A"], { cwd: project })
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: project })
  let churning = true, written = 0
  const churn = (async () => {
    while (churning) {
      for (let count = 0; count < CHURN; count += 1) {
        const index = Math.floor(Math.random() * FILES)
        writeFileSync(join(project, "src", `part${index % 300}`, `file${index}.ts`), `export const value${index} = ${Date.now()}\n${"// churned line\n".repeat(60)}`)
        written += 1
      }
      await delay(100)
    }
  })()

  const heardAt = new Map<string, number>()
  const model = await scriptedModel({
    reply: (heard) => {
      for (const match of heard.matchAll(/BENCH-(S\d+)/g)) if (!heardAt.has(match[1]!)) heardAt.set(match[1]!, performance.now())
      return { text: "Done." }
    },
    answers: SCRIPTED_GETS,
  })
  const env = { ...sandbox.env }
  await pointAt("claude", sandbox, model.url, env, "claude-send-bench")
  Object.assign(env, { CLAUDE_CONFIG_DIR: join(sandbox.home, ".claude"), ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "claude-send-bench" })
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR"] as const)
    if (!env[key]?.startsWith(sandbox.home)) throw new Error(`Claude's ${key} is outside its sealed home; nothing was started`)

  const held = new Map<string, number | null>()
  const unlog = followHostLog((line) => {
    if (line.scope !== "checkpoints" || line.message !== "a turn's checkpoint was saved") return
    const saved = SavedCheckpoint.safeParse(line.fields)
    if (saved.success) held.set(saved.data.request, saved.data.heldMs ?? null)
  })
  const samples: Sample[] = []
  const loads: RunLoad[] = []
  const gitRunner = new Git()
  try {
    let sequence = 0
    for (const [run, arm] of [["A1", "waited"], ["B1", "held"], ["B2", "held"], ["A2", "waited"]] as const) {
      const holds = arm === "held" ? new WriteHolds() : undefined
      const raw = sealedDrivers([installClaude], holds ? { writeHolds: holds } : {}).get("claude")
      assert.ok(raw)
      assert.equal(Boolean(raw.firstWrite), arm === "held", "the held arm's driver holds writes, the waited arm's doesn't")
      // As admission hands it: the sealed launch, never the person's own login.
      const driver: ProviderLiveDriver = { ...raw, start: (cwd, options) => raw.start(cwd, admitted("claude", options, { env })) }
      const snapshots = new WorkspaceSnapshots(gitRunner, join(sandbox.root, `snapshots-${run}`))
      const owner = new LiveConversations({
        root: join(sandbox.root, `conversations-${run}`), appPath: sandbox.root, workspaceSnapshots: snapshots,
        ...holds && { writeHolds: holds },
        driver: () => driver, history: async () => null, emit: () => {},
        // No MCP servers: the sealed home has none, and the send is timed without any.
        mcpSnapshot: async (cwd: string) => ({ cwd, generatedAt: Date.now(), servers: [], providers: [] }),
      })
      const id = randomUUID()
      const load: RunLoad = { run, arm, cores: cpus().length, start: reading(), end: [] }
      loads.push(load)
      try {
        await owner.start("claude", project, { conversationId: id, modeId: "bypassPermissions" })
        const first = `S${++sequence}`
        owner.submit(id, randomUUID(), `BENCH-${first} start`)
        for (const deadline = Date.now() + 120_000; !heardAt.has(first); await delay(50)) if (Date.now() > deadline) throw new Error(`${run}: Claude never asked the stand-in model: ${JSON.stringify({ session: owner.snapshot(id)?.session, requests: owner.snapshot(id)?.requests.map((item) => ({ status: item.status, error: item.error })) })}`)
        const settled = () => owner.snapshot(id)?.session.status !== "running" && !owner.snapshot(id)?.requests.some((request) => request.status === "dispatching" || request.status === "queued")
        for (const deadline = Date.now() + 60_000; !settled(); await delay(50)) if (Date.now() > deadline) throw new Error(`${run}: the first turn didn't settle`)
        for (let send = 0; send < SENDS; send += 1) {
          await delay(GAP_MS)
          const tag = `S${++sequence}`, request = randomUUID()
          const began = performance.now()
          owner.submit(id, request, `BENCH-${tag} next`)
          for (const deadline = Date.now() + 60_000; !heardAt.has(tag); await delay(5)) if (Date.now() > deadline) throw new Error(`${run}: ${tag} never reached the model`)
          const modelMs = Math.round((heardAt.get(tag)! - began) * 10) / 10
          for (const deadline = Date.now() + 60_000; !settled(); await delay(20)) if (Date.now() > deadline) throw new Error(`${run}: ${tag}'s turn didn't settle`)
          for (const deadline = Date.now() + 30_000; !owner.snapshot(id)?.requests.find((item) => item.id === request)?.snapshots?.before; await delay(20)) if (Date.now() > deadline) break
          const before = owner.snapshot(id)?.requests.find((item) => item.id === request)?.snapshots?.before
          samples.push({ tag, arm, run, modelMs, heldMs: held.get(request) ?? null, before: before?.kind, ...before?.kind === "unavailable" && { reason: before.reason } })
        }
        const mine = samples.filter((sample) => sample.run === run)
        load.end = reading()
        console.log(`${run} (${arm}): ${JSON.stringify(summary(mine.map((sample) => sample.modelMs)))}; before-points ready ${mine.filter((sample) => sample.before === "ready").length}/${mine.length}; checkpoint held p50 ${summary(mine.flatMap((sample) => sample.heldMs ?? [])).p50 ?? "none saved"} ms; load ${load.start[0]} → ${load.end[0]} on ${load.cores} cores`)
      } finally {
        await owner.stop()
        snapshots.close()
        await driver.stop?.()
      }
    }
  } finally {
    churning = false
    await churn
    unlog()
    await model.close()
    await gitRunner.close()
  }
  const report = {
    files: FILES, churnPerTick: CHURN, written, gapMs: GAP_MS, loads,
    waited: summary(samples.filter((sample) => sample.arm === "waited").map((sample) => sample.modelMs)),
    held: summary(samples.filter((sample) => sample.arm === "held").map((sample) => sample.modelMs)),
    readyBefore: Object.fromEntries((["waited", "held"] as const).map((arm) => [arm, `${samples.filter((sample) => sample.arm === arm && sample.before === "ready").length}/${samples.filter((sample) => sample.arm === arm).length}`])),
    samples,
  }
  console.log(`waited: ${JSON.stringify(report.waited)}\nheld: ${JSON.stringify(report.held)}\nready before-points: ${JSON.stringify(report.readyBefore)}`)
  if (values.out) await writeFile(values.out, JSON.stringify(report, null, 1) + "\n")
})
