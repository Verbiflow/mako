import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { createCodexEngine } from "@mako/host/harnesses/codex-app"
import { captureRoot } from "@mako/host/harnesses/host"
import { NATIVE_CAPTURE_ENV } from "@mako/host/harnesses/native-capture"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { LiveUpdate } from "@mako/sessions/live-content"
import { admitted } from "./fixtures/admitted-start.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"

/**
 * How soon Mako's Codex engine shows a turn: its first streamed token, each
 * tool row's first appearance and its end, measured where the engine emits
 * them, against the moment the prompt was sent.
 *
 *   npx tsx --tsconfig tsconfig.app.json scripts/measure-codex-live-latency.ts
 *       a shell call, a patch and an answer against the scripted model, sealed, five runs
 *   npx tsx --tsconfig tsconfig.app.json scripts/measure-codex-live-latency.ts --model gpt-5.6-luna --runs 1
 *       tiny real turns on the person's own Codex sign-in and home
 *
 * Beside each row's time it prints when the app-server's own item for the
 * call started, from the engine's native capture of the same run: when a
 * driver drawing the app-server's items showed the row. Prints times and
 * ids only, never content.
 */

const args = process.argv.slice(2)
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const realModel = option("--model")
const runs = Number(option("--runs") ?? (realModel ? 1 : 5))
const PROMPT = "Run `echo probe` in the shell, then create probe.txt containing the word probe with apply_patch, then reply with the single word done."

interface Run {
  firstToken?: number
  rows: Map<string, { shown: number; ended?: number; item?: number }>
  done?: number
}

const CapturedItem = z.object({
  at: z.string(),
  message: z.object({ method: z.literal("item/started"), params: z.object({ item: z.object({ id: z.string() }).loose() }).loose() }).loose(),
})

function scripted(): (heard: string) => ScriptedReply | undefined {
  const steps: ScriptedReply[] = [
    { reasoning: "Run the command first.", text: "Running it.", call: { id: "call_1", name: "exec_command", arguments: { cmd: "echo probe" } } },
    { reasoning: "Now the file.", call: { id: "call_2", name: "apply_patch", input: "*** Begin Patch\n*** Add File: probe.txt\n+probe\n*** End Patch\n" } },
    { reasoning: "Both done.", text: "done" },
  ]
  let next = 0
  return () => steps[next++]
}

function observe(run: Run, start: number, update: LiveUpdate): void {
  const at = performance.now() - start
  if ((update.kind === "text" || update.kind === "thinking") && update.text && run.firstToken === undefined) run.firstToken = at
  if (update.kind === "tool" && !run.rows.has(update.id)) run.rows.set(update.id, { shown: at })
  const status = update.kind === "tool" || update.kind === "tool-update" ? update.status : undefined
  const row = update.kind === "tool" || update.kind === "tool-update" ? run.rows.get(update.id) : undefined
  if (row && status && status !== "pending" && row.ended === undefined) row.ended = at
}

/** When the app-server sent each item's start, from the run's native capture, against `start`. */
async function itemStarts(root: string, start: number): Promise<Map<string, number>> {
  const starts = new Map<string, number>()
  const folder = captureRoot({ dataRoot: root })
  for (const name of await readdir(folder).catch(() => [])) {
    for (const line of (await readFile(join(folder, name), "utf8")).split("\n")) {
      const item = line ? CapturedItem.safeParse(JSON.parse(line)).data : undefined
      if (item && !starts.has(item.message.params.item.id)) starts.set(item.message.params.item.id, Date.parse(item.at) - performance.timeOrigin - start)
    }
  }
  return starts
}

async function measure(project: string, env: NodeJS.ProcessEnv, model: string): Promise<Run> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mako-codex-latency-")))
  process.env[NATIVE_CAPTURE_ENV] = "codex"
  const codex = createCodexEngine({ dataRoot: root })
  const id = randomUUID()
  const run: Run = { rows: new Map() }
  let start = performance.now()
  let session: LiveSessionState | undefined
  const take = (event: LiveDriverEvent) => {
    if (event.type === "live-session") session = event.session
    if (event.type === "live-update") observe(run, start, event.update)
    if (event.type === "live-updates") for (const update of event.updates) observe(run, start, update)
  }
  try {
    await codex.start(project, admitted("codex", {
      conversationId: id,
      tuning: { model },
      emit: take,
      mcpSnapshot: async () => ({ cwd: project, generatedAt: Date.now(), servers: [], providers: [] }),
    }, { env }))
    start = performance.now()
    await codex.prompt(id, PROMPT, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    const deadline = Date.now() + 180_000
    while (session?.status !== "ready" && session?.status !== "failed") {
      if (Date.now() > deadline) throw new Error("The turn did not end within 180 s")
      await delay(5)
    }
    run.done = performance.now() - start
    await codex.close(id).catch(() => undefined)
    await delay(200)
    const starts = await itemStarts(root, start)
    for (const [id, row] of run.rows) {
      const item = starts.get(id) ?? starts.get(id.split(":").at(-1) ?? id)
      if (item !== undefined) row.item = item
    }
    return run
  } finally {
    await codex.close(id).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

function report(results: Run[]): void {
  const ms = (value: number | undefined) => (value === undefined ? "—" : value.toFixed(1))
  for (const [index, run] of results.entries()) {
    console.log(`run ${index + 1}: first token ${ms(run.firstToken)} ms · turn end ${ms(run.done)} ms`)
    for (const [id, row] of run.rows) console.log(`  row ${id}: shown ${ms(row.shown)} ms · ended ${ms(row.ended)} ms · the app-server's item started ${ms(row.item)} ms`)
  }
}

if (realModel) {
  const project = await realpath(await mkdtemp(join(tmpdir(), "mako-codex-latency-project-")))
  await mkdir(join(project, ".git"))
  try {
    const results: Run[] = []
    for (let index = 0; index < runs; index++) results.push(await measure(project, process.env, realModel))
    report(results)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
} else {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mako-codex-latency-sealed-")))
  const home = join(root, "home")
  const project = join(root, "project")
  await mkdir(join(project, ".git"), { recursive: true })
  await mkdir(join(home, ".codex"), { recursive: true })
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, ".codex"), TMPDIR: root }
  try {
    const results: Run[] = []
    for (let index = 0; index < runs; index++) {
      const model = await scriptedModel({ reply: scripted() })
      await writeFile(join(home, ".codex", "config.toml"), `openai_base_url = "${model.url}/v1"\nchatgpt_base_url = "${model.url}/backend-api"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\n\n[features]\nplugins = false\n`)
      await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "mako-latency" }))
      try {
        results.push(await measure(project, env, "gpt-5.5"))
      } finally {
        await model.close()
      }
    }
    report(results)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
