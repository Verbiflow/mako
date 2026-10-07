// What a conversation costs each harness as it grows, on its real CLI:
// `npm run test:session-flows -- --bench [harness...]`.
//
// growth  real turns that each run one shell command with ~10KB of output,
//         so the native store holds real tool records. Per turn: the
//         provider's CPU, bytes it wrote to disk, its footprint, the native
//         store's size, and Mako's own CPU and window traffic. Work that
//         climbs with the turn number is work over the whole conversation.
// wake    an imported short and long history resumed for one turn: what
//         loading history costs at launch and in memory.
//
// Memory and disk come from proc_pid_rusage for every process in the
// provider's process group (darwin only); exited tool shells are not counted.
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const GROWTH_TURNS = 10
const SHORT_EXCHANGES = 2
const LONG_EXCHANGES = 100
const IDLE_SETTLE_MS = 5_000

// rusage_info_v4 as uint64s after the 16-byte uuid.
const RUSAGE = String.raw`
import ctypes, json, sys
lib = ctypes.CDLL("/usr/lib/libproc.dylib")
class Timebase(ctypes.Structure): _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]
timebase = Timebase(); ctypes.CDLL("/usr/lib/libSystem.dylib").mach_timebase_info(ctypes.byref(timebase))
ms = lambda ticks: ticks * timebase.numer // timebase.denom // 1_000_000
for pid in map(int, sys.argv[1:]):
    raw = (ctypes.c_uint64 * 48)()
    if lib.proc_pid_rusage(pid, 4, raw) != 0: continue
    u = raw[2:]
    print(json.dumps({"pid": pid, "footprint": u[7], "peak": u[28], "cpuMs": ms(u[0] + u[1] + u[10] + u[11]), "written": u[17]}))
`

export function historyProbe({ root, profile, emitters, fed }) {
  const registry = join(profile, "runtime", "provider-children.json")
  const leaders = (id) => {
    try {
      return JSON.parse(readFileSync(registry, "utf8")).children
        .filter((entry) => entry.owner === id && entry.host === process.pid).map((entry) => entry.pid)
    } catch { return [] }
  }
  const group = (pids) => {
    if (!pids.length) return []
    const table = spawnSync("ps", ["-axo", "pid=,pgid=,comm="], { encoding: "utf8" }).stdout
    const names = new Map()
    for (const line of table.split("\n")) {
      const [, pid, pgid, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/) ?? []
      if (pid && (pids.includes(Number(pgid)) || pids.includes(Number(pid)))) names.set(Number(pid), command.split("/").at(-1))
    }
    const out = spawnSync("python3", ["-c", RUSAGE, ...[...names.keys()].map(String)], { encoding: "utf8" })
    return out.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((entry) => ({ ...entry, name: names.get(entry.pid) }))
  }
  return {
    emitters,
    /** One reading of a conversation's provider processes, native store and Mako's side of it. */
    sample(id, snapshot) {
      const processes = group(leaders(id))
      const fedEntry = fed.get(id)
      return {
        processes: new Map(processes.map((entry) => [entry.pid, entry])),
        footprint: sum(processes, "footprint"),
        peak: Math.max(0, ...processes.map((entry) => entry.peak)),
        store: storeBytes(nativePath(snapshot)),
        journal: storeBytes(join(root, "conversations", `${id}.sqlite`)),
        hostCpuMs: Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000),
        fed: fedEntry?.bytes ?? 0,
      }
    },
    /** Each launch of a conversation, from the host's provider-startup records. */
    launches(id) {
      const lines = readFileSync(join(root, "host.log"), "utf8").split("\n")
        .filter((line) => line.includes("provider-startup") && line.includes(`conversation=${id}`) && line.includes("state=done"))
      const attempts = new Map()
      for (const line of lines) {
        const field = (name) => line.match(new RegExp(`\\b${name}=(\\S+)`))?.[1]
        const attempt = attempts.get(field("attempt")) ?? {}
        attempts.set(field("attempt"), attempt)
        attempt[field("phase")] = Math.round(Number(field("durationMs")))
      }
      return [...attempts.values()]
    },
  }
}

export function benchFlows(probe) {
  return [
    { name: "growth", declared: () => true, run: (h) => growth(h, probe) },
    { name: "wake", declared: (driver) => probe.emitters.get(driver.provider) ? true : "no session import", run: (h) => wake(h, probe) },
  ]
}

async function growth(h, probe) {
  const { id } = await h.conversation("growth")
  const turns = []
  let before = probe.sample(id, h.snapshot(id))
  for (let turn = 1; turn <= GROWTH_TURNS; turn++) {
    const began = Date.now()
    const from = turn * 100_000
    await h.completed(id, `Run the shell command \`seq ${from} ${from + 1500}\` exactly once, then reply with only DONE. Do not run anything else.`)
    const ms = Date.now() - began
    const after = probe.sample(id, h.snapshot(id))
    turns.push(step(before, after, ms))
    before = after
  }
  await delay(IDLE_SETTLE_MS)
  const idle = probe.sample(id, h.snapshot(id))
  return { turns, idleFootprintMB: mb(idle.footprint), storeKB: kb(idle.store), journalKB: kb(idle.journal), launches: probe.launches(id) }
}

/**
 * A history written into the harness's own store through its session
 * emitter, resumed by its CLI and asked about its first message: the path a
 * conversation moved here from another harness takes.
 */
export async function resumeImported(h, emitter, label, exchanges) {
  const cwd = join(h.root, "work", h.provider, `${label}-${randomUUID().slice(0, 8)}`)
  await mkdir(cwd, { recursive: true })
  const codename = `LANTERN-${randomUUID().slice(0, 6).toUpperCase()}`
  const emitted = await emitter.emit(syntheticThread(h.provider, cwd, codename, exchanges))
  const id = randomUUID()
  await h.owner.start(h.provider, cwd, { conversationId: id, resume: emitted.sessionId, threadPath: emitted.path, title: `Session flows: ${label}`, modeId: h.fullMode })
  h.open.add(id)
  h.current = id
  const began = Date.now()
  const requestId = await h.completed(id, "What codename did I give in my first message? Reply with only the codename. Do not use any tools.")
  const ms = Date.now() - began
  if (!h.reply(id, requestId).includes(codename)) throw new Error(`The imported ${label} history did not load: ${JSON.stringify(h.reply(id, requestId).slice(0, 80))}`)
  return { id, ms }
}

async function wake(h, probe) {
  const sizes = {}
  for (const [label, exchanges] of [["short", SHORT_EXCHANGES], ["long", LONG_EXCHANGES]]) {
    const { id, ms } = await resumeImported(h, probe.emitters.get(h.provider), `wake-${label}`, exchanges)
    const sample = probe.sample(id, h.snapshot(id))
    const processes = [...sample.processes.values()]
    sizes[label] = { exchanges, storeKB: kb(sample.store), turnMs: ms, footprintMB: mb(sample.footprint), peakMB: mb(sample.peak), cpuMs: sum(processes, "cpuMs"), writtenKB: kb(sum(processes, "written")), launches: probe.launches(id) }
  }
  return { wake: sizes }
}

/** A long ordinary session: requests, answers and a file read per exchange, as text an import carries. */
function syntheticThread(harness, cwd, codename, exchanges) {
  const entries = []
  for (let n = 0; n < exchanges; n++) {
    const opening = n === 0 ? `My codename for this project is ${codename}; remember it. ` : ""
    entries.push({ kind: "user", text: `${opening}Exchange ${n}: look at src/module_${n}.ts and tell me whether its retry loop backs off correctly when the upstream returns 429, and what you would change.` })
    const source = Array.from({ length: 40 }, (_, line) => `export const step${n}_${line} = (attempt: number) => Math.min(30_000, 250 * 2 ** attempt) // line ${line}`).join("\n").slice(0, 1900)
    entries.push({
      kind: "assistant",
      blocks: [
        { type: "tool", name: "Read", input: JSON.stringify({ path: `src/module_${n}.ts` }), output: source },
        { type: "text", text: `module_${n} doubles the delay per attempt and caps it at thirty seconds, which is right for 429s, but it never reads Retry-After and it retries non-idempotent POSTs. I would honour Retry-After when present, add jitter so clients don't retry in lockstep, and only retry requests that carry an idempotency key.` },
      ],
    })
  }
  return { ref: { harness, nativeId: "", path: "", cwd }, entries }
}

/** Counters climb per process; one that started since `before` counts from zero, one that exited is lost. */
function step(before, after, ms) {
  const work = [...after.processes.values()].map((entry) => {
    const earlier = before.processes.get(entry.pid)
    return { name: entry.name, cpuMs: entry.cpuMs - (earlier?.cpuMs ?? 0), written: entry.written - (earlier?.written ?? 0), footprint: entry.footprint }
  })
  const heaviest = work.filter((entry) => entry.written > 1024 * 1024 || entry.cpuMs > 1000)
  return {
    ms,
    cpuMs: sum(work, "cpuMs"),
    writtenKB: kb(sum(work, "written")),
    ...heaviest.length && { heaviest: heaviest.map((entry) => `${entry.name} ${entry.cpuMs}ms ${mb(entry.written)}MB written ${mb(entry.footprint)}MB`) },
    footprintMB: mb(after.footprint),
    peakMB: mb(after.peak),
    storeKB: kb(after.store),
    storeGrowthKB: kb(after.store - before.store),
    journalGrowthKB: kb(after.journal - before.journal),
    hostCpuMs: after.hostCpuMs - before.hostCpuMs,
    fedKB: kb(after.fed - before.fed),
    processes: [...after.processes.values()].map((entry) => `${entry.name} ${mb(entry.footprint)}MB`).join(", "),
  }
}

function nativePath(snapshot) {
  const binding = snapshot?.control?.bindings.find((entry) => entry.id === snapshot.control.activeBindingId)
  return binding?.path ?? snapshot?.threadPath
}

/** A file with its SQLite sidecars, or everything under a directory. */
function storeBytes(path) {
  if (!path) return 0
  const file = path.split("#")[0]
  if (!existsSync(file)) return 0
  const stat = statSync(file)
  if (stat.isDirectory()) return readdirSync(file, { recursive: true }).reduce((total, name) => {
    try { const entry = statSync(join(file, name)); return total + (entry.isFile() ? entry.size : 0) } catch { return total }
  }, 0)
  return stat.size + ["-wal", "-shm"].reduce((total, suffix) => total + (existsSync(file + suffix) ? statSync(file + suffix).size : 0), 0)
}

const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0)
const mb = (bytes) => Math.round(bytes / 1024 / 1024)
const kb = (bytes) => Math.round(bytes / 1024)
