import "./lib/scratch-git.mjs"
// What each real harness costs in memory and time, through Mako's own live
// driver, in a sealed home against the scripted model (no account; nothing
// leaves this machine): how long it takes to open, its process tree's
// resident memory open and at idle, each turn's peak and the memory it rests
// at after it as the conversation grows, and how long a resume takes at a
// short and a long conversation. The host's own heap after a collection is
// read beside it, so growth in Mako's driver shows apart from the harness's.
// It reports numbers and asserts none.
//
//   node --expose-gc --import tsx scripts/probe-harness-footprint.ts [<harness>...] [--turns N] [--json <file>]
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { installClaude } from "@mako/host/harnesses/claude/index"
import { installCodex } from "@mako/host/harnesses/codex/index"
import { installDevin } from "@mako/host/harnesses/devin/index"
import { installGrok } from "@mako/host/harnesses/grok/index"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { installOpenCode } from "@mako/host/harnesses/opencode/index"
import { readProcessTable, type ProcessRow } from "@mako/host/usage/mako-footprint"
import { ProviderLaunchTrace } from "@mako/host/harnesses/provider-launch"
import { admitted } from "./fixtures/admitted-start.ts"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { sandboxed, type Sandbox } from "./harness-sandbox.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"
import { scriptedWindsurf } from "./scripted-windsurf.ts"

const args = process.argv.slice(2)
const take = (flag: string) => { const at = args.indexOf(flag); return at === -1 ? undefined : args.splice(at, 2)[1] }
const TURNS = Number(take("--turns") ?? 40)
const json = take("--json")
const named = args.filter((arg) => !arg.startsWith("--"))
// SAFETY: `--expose-gc` puts `gc` on the global object; the check below says when it wasn't given.
const gc = (globalThis as { gc?: () => void }).gc
if (!gc) throw new Error("Run with node --expose-gc")

/** Each turn's words, sized so the conversation grows the way a working one does: about 8 KB a turn. */
const PROMPT = "Read this and answer briefly. ".repeat(70)
const ANSWER = "Here is the part you asked about, in full. ".repeat(140)

const MB = (bytes: number) => Math.round(bytes / 1024 / 1024)

async function tree(): Promise<{ bytes: number; processes: number; top: string[] }> {
  const rows = await readProcessTable()
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  const found: ProcessRow[] = []
  const walk = (pid: number) => { for (const child of children.get(pid) ?? []) { if (/^ps\b|\/ps |esbuild/.test(child.command)) continue; found.push(child); walk(child.pid) } }
  walk(process.pid)
  found.sort((a, b) => b.rssKb - a.rssKb)
  return { bytes: found.reduce((sum, row) => sum + row.rssKb * 1024, 0), processes: found.length, top: found.slice(0, 3).map((row) => `${Math.round(row.rssKb / 1024)}MB ${row.command.split(" ")[0]!.split("/").pop()}`) }
}

function heap(): number {
  gc!()
  gc!()
  return process.memoryUsage().heapUsed
}

interface Report {
  harness: string
  openMs: number
  openMB: number
  idleMB: number
  processes: number
  top: string[]
  turns: { turn: number; peakMB: number; restMB: number; heapMB: number; ms: number }[]
  /** Each open's phases, by how long they took altogether. */
  phases: { resume: boolean; turns: number; ms: number; phases: Record<string, number> }[]
  resumeShort?: { ms: number; MB: number }
  resumeLong?: { ms: number; MB: number }
  restSlopeKBPerTurn?: number
  heapSlopeKBPerTurn?: number
  failed?: string
}

/** Least-squares slope over the second half of the turns: what each turn leaves behind once the session has warmed. */
function slope(points: [number, number][]): number {
  const half = points.slice(Math.floor(points.length / 2))
  const n = half.length
  const mx = half.reduce((s, [x]) => s + x, 0) / n, my = half.reduce((s, [, y]) => s + y, 0) / n
  const num = half.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0), den = half.reduce((s, [x]) => s + (x - mx) ** 2, 0)
  return den ? num / den : 0
}

async function measure(harness: string, sandbox: Sandbox, driver: ProviderLiveDriver): Promise<Report> {
  let asked = 0
  const reply = (): ScriptedReply => { asked++; return { text: ANSWER } }
  const model = harness === "devin" ? await scriptedWindsurf({ reply }) : await scriptedModel({ reply, answers: SCRIPTED_GETS })
  const env = { ...sandbox.env }
  await pointAt(harness, sandbox, model.url, env, "footprint-probe")
  if (harness === "claude") Object.assign(env, { CLAUDE_CONFIG_DIR: join(sandbox.home, ".claude"), ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "footprint-probe" })
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "CODEX_HOME"] as const)
    if (env[key] && !env[key].startsWith(sandbox.home)) throw new Error(`${harness}'s ${key} is outside its sealed home; nothing was started`)
  const report: Report = { harness, openMs: 0, openMB: 0, idleMB: 0, processes: 0, top: [], turns: [], phases: [] }
  let id = randomUUID()
  let events: LiveDriverEvent[] = []
  const emit = (event: LiveDriverEvent) => {
    events.push(event)
    if (events.length > 200) events = events.slice(-50)
    if (event.type === "live-permission") {
      const option = event.request.options?.find((candidate) => /allow/i.test(`${candidate.kind} ${candidate.optionId}`)) ?? event.request.options?.[0]
      if (option) void Promise.resolve(driver.permission(id, event.request.id, { kind: "choice", optionId: option.optionId }, { assertCurrent() {}, report() {} })).catch(() => {})
    }
  }
  let session: { status?: string; nativeId?: string } | undefined
  const track = (event: LiveDriverEvent) => { if (event.type === "live-session") session = event.session; emit(event) }
  const open = async (resume?: string) => {
    id = randomUUID()
    session = undefined
    const began = performance.now()
    const phases = new Map<string, number>()
    const options = admitted(harness, {
      conversationId: id, emit: track, ...resume && { resume },
      mcpSnapshot: async () => ({ cwd: sandbox.project, generatedAt: Date.now(), servers: [], providers: [] }),
    }, { env })
    options.trace = new ProviderLaunchTrace({ provider: harness, conversation: id }, { report: (record) => {
      if (record.state === "done" || record.state === "failed") phases.set(record.phase, Math.round((phases.get(record.phase) ?? 0) + record.durationMs))
    } })
    await driver.start(sandbox.project, options)
    const ms = Math.round(performance.now() - began)
    report.phases.push({ resume: Boolean(resume), turns: report.turns.length, ms, phases: Object.fromEntries(phases) })
    return ms
  }
  const turn = async (n: number) => {
    const before = asked
    const began = performance.now()
    let peak = 0
    let sampling = true
    const sampler = (async () => { while (sampling) { peak = Math.max(peak, (await tree()).bytes); await delay(150) } })()
    void driver.prompt(id, `${n}: ${PROMPT}`, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    const by = Date.now() + 90_000
    while (asked === before && Date.now() < by) await delay(25)
    if (asked === before) throw new Error(`turn ${n}: the model was never asked`)
    let settled = 0
    while (Date.now() < by) {
      const status = session?.status
      settled = status === "ready" ? settled + 1 : 0
      if (settled >= 4) break
      await delay(50)
    }
    if (settled < 4) throw new Error(`turn ${n}: still ${session?.status} after 90 s`)
    const ms = Math.round(performance.now() - began)
    sampling = false
    await sampler
    await delay(500)
    const rest = await tree()
    report.turns.push({ turn: n, peakMB: MB(Math.max(peak, rest.bytes)), restMB: MB(rest.bytes), heapMB: Math.round(heap() / 1024 / 1024 * 10) / 10, ms })
    return rest
  }
  const close = async () => { await Promise.resolve(driver.close(id)).catch(() => {}); await delay(1500) }
  try {
    report.openMs = await open()
    report.openMB = MB((await tree()).bytes)
    await delay(3000)
    const idle = await tree()
    Object.assign(report, { idleMB: MB(idle.bytes), processes: idle.processes, top: idle.top })
    await turn(1)
    const nativeId = session?.nativeId
    if (!nativeId) throw new Error("the session named no native id to resume")
    await close()
    report.resumeShort = { ms: await open(nativeId), MB: MB((await tree()).bytes) }
    for (let n = 2; n <= TURNS; n++) await turn(n)
    await close()
    report.resumeLong = { ms: await open(nativeId), MB: MB((await tree()).bytes) }
    await turn(TURNS + 1)
    const snapshot = process.env["FOOTPRINT_SNAPSHOT"]
    if (snapshot) { heap(); (await import("node:v8")).writeHeapSnapshot(`${snapshot}-${harness}.heapsnapshot`) }
    const warm = report.turns.filter((row) => row.turn > 1 && row.turn <= TURNS)
    report.restSlopeKBPerTurn = Math.round(slope(warm.map((row) => [row.turn, row.restMB * 1024])))
    report.heapSlopeKBPerTurn = Math.round(slope(warm.map((row) => [row.turn, row.heapMB * 1024])))
  } catch (error) {
    report.failed = error instanceof Error ? error.message : String(error)
  } finally {
    await close()
    await model.close()
  }
  return report
}

const drivers = sealedDrivers([installClaude, installCodex, installOpenCode, installGrok, installDevin])
const harnesses = named.length ? named : ["claude", "codex", "opencode", "grok", "devin"]
const reports: Report[] = []
for (const harness of harnesses) {
  const driver = drivers.get(harness)
  if (!driver) throw new Error(`${harness} has no sealed driver`)
  if (!driver.available(process.cwd())) { console.log(`${harness}: skipped, not installed`); continue }
  let report: Report | undefined
  try {
    await sandboxed("mako-footprint", harness, async (sandbox) => { report = await measure(harness, sandbox, driver) })
  } catch (error) {
    report ??= { harness, openMs: 0, openMB: 0, idleMB: 0, processes: 0, top: [], turns: [], phases: [], failed: error instanceof Error ? error.message : String(error) }
  }
  reports.push(report!)
  const r = report!
  const peak = Math.max(0, ...r.turns.map((row) => row.peakMB))
  const last = r.turns.at(-2)
  console.log(`${harness}: open ${r.openMs} ms at ${r.openMB} MB; idle ${r.idleMB} MB in ${r.processes} processes (${r.top.join(", ")}); peak ${peak} MB; rest after turn ${last?.turn} ${last?.restMB} MB; resume ${r.resumeShort?.ms} ms short, ${r.resumeLong?.ms} ms long (${r.resumeLong?.MB} MB); rest slope ${r.restSlopeKBPerTurn} KB/turn, host heap slope ${r.heapSlopeKBPerTurn} KB/turn${r.failed ? `; FAILED ${r.failed}` : ""}`)
  for (const open of r.phases) console.log(`  ${open.resume ? "resume" : "open"} after ${open.turns} turns, ${open.ms} ms: ${Object.entries(open.phases).map(([phase, ms]) => `${phase} ${ms}`).join(", ")}`)
}
if (json) await writeFile(json, JSON.stringify(reports, null, 1))
process.exit(0)
