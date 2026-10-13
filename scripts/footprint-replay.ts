// What today's footprint rules make of turns a host already recorded, and
// what this Mac changes on its own, read-only:
//
//   npx tsx scripts/footprint-replay.ts learn <minutes> --noise <rows.json>
//   npx tsx scripts/footprint-replay.ts replay <journal.sqlite>... [--noise <rows.json>] [--out <report.json>]
//
// `learn` samples the FSEvents history every minute as an idle host would
// (no Thread runs here) and saves the baseline it learns. `replay` takes
// each turn a journal recorded, with the weak paths it kept then, and runs
// them through the real tracker and footprint reader: the turn's calls and
// what they named, the journal's tracked roots, the harness stores and the
// other sessions the catalog says were active, and the learned baseline.
// It prints what each rule took and what is left; `--out` writes every
// path with its verdict, for a person to review. Nothing here writes to a
// journal or a store: the replay's journal is a temporary one.
//
//   npx tsx scripts/footprint-replay.ts live [--noise <rows.json>] [--hold <seconds>]
//
// `live` runs one turn through the real history while this Mac goes on as
// it is: commands write a new `~/.config` folder, a named `/tmp` file, a
// sibling folder and a path only their output mentions, then it removes them.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { ReportedEffectSchema, type HistorySince, type ReportedEffect, type TrackerEventSource, type TrackerFileSystem } from "@mako/protocol"
import { FakeClock } from "@mako/protocol/attribution-conformance"
import { SessionCatalog, translatorBuild } from "@mako/sessions"
import type { PathVerdict } from "@mako/host/attribution/footprint-reader"
import { harnessScratch, harnessStores, sessionFolders, sessionIds, type CataloguedSession } from "@mako/host/attribution/index"
import { JournalStore } from "@mako/host/attribution/journal-store"
import type { NoiseRow } from "@mako/host/attribution/noise-baseline"
import { within } from "@mako/host/attribution/paths"
import { nodeFileSystem, watcherEvents } from "@mako/host/attribution/ports"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { childHistory } from "@mako/host/workspaces/watch-backend"
import { storeReader } from "./decode-compare"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const value = args[at + 1]
  args.splice(at, 2)
  return value
}
const noisePath = option("--noise")
const outPath = option("--out")
/** How long `live` keeps its turn open after the writes, as the machine goes on. */
const holdS = Number(option("--hold") ?? 2)
const [command, ...rest] = args
const home = homedir()
const roots = [home, "/private/tmp"]

const NoiseRowSchema = z.object({ key: z.string(), kind: z.enum(["template", "folder"]), idle: z.number(), weak: z.number(), threads: z.array(z.string()), at: z.number() })

/**
 * Every harness's sessions on this Mac, as the host's catalog lists them.
 * The first scan reads every store (seconds); each later one only what
 * moved (tens of milliseconds), so a long run can stay as current as a host.
 */
function sessionCatalogs(): () => Promise<CataloguedSession[]> {
  const translator = translatorBuild()
  const catalogs = ["claude", "codex", "cursor", "devin", "devin-ide", "grok", "opencode"].map((reader) => new SessionCatalog([storeReader(reader, home)], { translator, readOnly: true }))
  return async () => {
    const out: CataloguedSession[] = []
    for (const catalog of catalogs) {
      await catalog.scan().catch(() => [])
      out.push(...catalog.list())
    }
    return out
  }
}

/** Sessions active since `since` that had begun by `now`: the catalog only knows when each last moved. */
const othersAt = (sessions: readonly (CataloguedSession & { startedAt?: string })[], now: () => number) => (thread: string, since: number) =>
  sessionFolders(sessions.filter((session) => !session.startedAt || Date.parse(session.startedAt) <= now()), {}, thread, since)

function storage(rows: readonly NoiseRow[]): string {
  const folder = mkdtempSync(join(tmpdir(), "mako-footprint-replay-"))
  const store = JournalStore.open(join(folder, "journal.sqlite"), { device: "replay" })
  store.saveNoise(rows)
  store.close()
  return folder
}

const loadNoise = (): NoiseRow[] => (noisePath ? z.array(NoiseRowSchema).parse(JSON.parse(readFileSync(noisePath, "utf8"))) : [])

async function learn(minutes: number): Promise<void> {
  if (!noisePath) throw new Error("Pass --noise <rows.json> to save the baseline to.")
  const scan = sessionCatalogs()
  let sessions = await scan()
  const clock = { now: () => Date.now() }
  // A first run starts the baseline; a later one goes on from what it saved.
  const folder = storage(existsSync(noisePath) ? loadNoise() : [])
  const history = childHistory()
  const tracker = await LaptopTracker.open(
    { fs: everyFile(), events: watcherEvents(() => undefined, history), clock, storage: folder, device: "learn" },
    {
      footprint: {
        home,
        roots,
        stores: () => [...harnessStores(sessions.map((session) => session.path)), ...harnessScratch(home), join(home, ".mako")],
        others: (thread, since) => othersAt(sessions, clock.now)(thread, since),
        sessions: (thread) => sessionIds(sessions, thread),
      },
      log: (message, facts) => console.log(message, JSON.stringify(facts)),
    },
  )
  const reader = tracker.footprints!
  for (let minute = 0; minute < minutes; minute++) {
    await new Promise((resolve) => setTimeout(resolve, 60_000))
    sessions = await scan()
    await reader.sampleIdleNow()
  }
  writeFileSync(noisePath, JSON.stringify(tracker.store.noise()))
  console.log(`learned ${reader.baseline.size} keys; strongest:`)
  for (const row of reader.baseline.list(30)) console.log(`  ${row.score.toFixed(2).padStart(6)}  ${row.kind.padEnd(8)} ${row.key.replace(home, "~")}`)
  await tracker.close()
  rmSync(folder, { recursive: true, force: true })
}

/** A file system where every path is a small file: the old windows' paths may be gone now, and that says nothing about then. */
function everyFile(): TrackerFileSystem {
  return {
    stat: async () => ({ kind: "file", dev: 1, ino: 1, size: 1, mode: 0o100644, mtimeNs: 0n, ctimeNs: 0n }),
    read: async () => null,
    walk: async () => [],
  }
}

const Activity = z.object({
  kind: z.enum(["turn", "call", "background"]), id: z.string(), session: z.string(), thread: z.string(), turn: z.string().nullable(), cwd: z.string().nullable(),
  named: z.string(), effects: z.string().nullable(), started_at: z.number(), ended_at: z.number().nullable(),
})
const Footprint = z.object({ session: z.string(), turn: z.string().nullable(), path: z.string() })
const RootRow = z.object({ path: z.string() })
type Category = "other checkout" | "harness store" | "caches and app data" | "agent tools" | "temporary scratch" | "home files" | "elsewhere"

/** Where a path is, in the words of the measurement, independent of the rules. */
function category(path: string): Category {
  const inside = path.startsWith(`${home}/`) ? path.slice(home.length + 1) : undefined
  if (inside === undefined) return path.startsWith("/private/tmp/") ? "temporary scratch" : "elsewhere"
  if (/^\.(claude|codex|cursor|grok|mako|local\/share\/opencode)(\/|$)|^\.claude\.json$|^Library\/Application Support\/(mako|Cursor|Devin)/.test(inside)) return "harness store"
  if (/^(Library|\.cache|\.npm|\.cargo|\.bun|\.pnpm-store|\.rustup|go\/pkg)(\/|$)/.test(inside)) return "caches and app data"
  if (/^\.[^/]+\//.test(inside)) return "agent tools"
  return inside.includes("/") ? "other checkout" : "home files"
}

interface Verdict {
  journal: string
  thread: string
  turn: string
  path: string
  category: Category
  outcome: string
  why?: string
}

async function replay(journals: readonly string[]): Promise<void> {
  const sessions = await sessionCatalogs()()
  const rows = loadNoise()
  const verdicts: Verdict[] = []
  for (const journal of journals) {
    const db = new DatabaseSync(journal, { readOnly: true })
    const activity = db.prepare("SELECT * FROM activity ORDER BY started_at").all().map((row) => Activity.parse(row))
    const footprint = db.prepare("SELECT session, turn, path FROM footprint").all().map((row) => Footprint.parse(row))
    const tracked = db.prepare("SELECT path FROM roots").all().map((row) => RootRow.parse(row).path)
    db.close()
    // The catalog doesn't know this dev host's Threads: a session run in one of its checkouts or turns' folders is theirs, not another's.
    const own = [...tracked, ...activity.flatMap((row) => (row.cwd ? [row.cwd] : []))].filter((folder) => !roots.some((root) => within(folder, root)))
    const theirs = sessions.filter((session) => !own.some((folder) => session.cwd && within(folder, session.cwd)))
    const dataRoot = dirname(dirname(journal))
    const clock = new FakeClock(Math.min(...activity.map((row) => row.started_at)) - 1)
    let window: string[] = []
    // Every path crosses, so each is explained; a host's read leaves rule folders out before they do, with the same verdicts.
    const events: TrackerEventSource = {
      watch: async () => ({ close() {} }),
      mark: async () => "0",
      since: async (_mark, root): Promise<HistorySince> => ({ paths: window.filter((path) => path.startsWith(`${root}/`)), complete: true }),
    }
    const verdict = new Map<string, PathVerdict>()
    const folder = storage(rows)
    const tracker = await LaptopTracker.open(
      { fs: everyFile(), events, clock, storage: folder, device: "replay" },
      {
        footprint: {
          home,
          roots,
          stores: () => [...harnessStores(sessions.map((session) => session.path)), ...harnessScratch(home), dataRoot, join(home, ".mako")],
          others: othersAt(sessions, () => clock.now()),
          sessions: (thread) => sessionIds(theirs, thread),
          explain: (_turn, path, decided) => verdict.set(path, decided),
        },
      },
    )
    const reader = tracker.footprints!
    const turns = activity.filter((row) => row.kind === "turn")
    for (const turn of turns) {
      const paths = [...new Set(footprint.filter((row) => row.session === turn.session && (row.turn ?? "") === turn.turn).map((row) => row.path))]
      if (!paths.length) continue
      const mark = { thread: turn.thread, session: turn.session }
      const at = (ms: number) => clock.advance(Math.max(0, ms - clock.now()))
      at(turn.started_at)
      reader.activity({ ...mark, kind: "turn", id: turn.id, edge: "start", at: clock.now(), cwd: turn.cwd ?? undefined })
      for (const call of activity.filter((row) => row.kind === "call" && row.session === turn.session && row.turn === turn.id)) {
        reader.activity({ ...mark, kind: "call", id: call.id, edge: "start", at: clock.now(), turn: turn.id, cwd: call.cwd ?? undefined, named: z.array(z.string()).parse(JSON.parse(call.named)) })
        const effects: ReportedEffect[] = call.effects ? z.array(ReportedEffectSchema).catch([]).parse(JSON.parse(call.effects)) : []
        if (effects.length) reader.reported({ ...mark, turn: turn.id, call: call.id, status: "completed", effects })
      }
      window = paths
      verdict.clear()
      at(turn.ended_at ?? turn.started_at)
      reader.activity({ ...mark, kind: "turn", id: turn.id, edge: "end", at: clock.now() })
      await reader.settled()
      // Between turns the reader samples idle stretches; the old window is no idle churn.
      window = []
      for (const path of paths) {
        const decided = verdict.get(path)
        const outcome = !decided ? "left out: ?" : "rule" in decided ? `left out: ${decided.rule}` : `kept: ${decided.kept}`
        verdicts.push({ journal, thread: turn.thread, turn: turn.id, path, category: category(path), outcome, why: decided && "rule" in decided ? `${decided.group.replace(home, "~")}${decided.why ? ` (${decided.why})` : ""}` : undefined })
      }
    }
    await tracker.close()
    rmSync(folder, { recursive: true, force: true })
    const own = verdicts.filter((item) => item.journal === journal)
    console.log(`\n${journal.replace(home, "~")}: ${turns.length} turns, ${own.length} weak paths before`)
    report(own)
  }
  console.log(`\nevery journal: ${verdicts.length} weak paths before, over ${new Set(verdicts.map((item) => `${item.journal}\u0000${item.turn}`)).size} turns with any`)
  report(verdicts)
  if (outPath) writeFileSync(outPath, JSON.stringify(verdicts, null, 1))
}

/** Each category before, and what became of it: kept by basis, or left out by rule. */
function report(verdicts: readonly Verdict[]): void {
  const count = (pick: (item: Verdict) => string) => {
    const counts = new Map<string, number>()
    for (const item of verdicts) counts.set(pick(item), (counts.get(pick(item)) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])
  }
  for (const [name, total] of count((item) => item.category)) {
    const outcomes = count((item) => (item.category === name ? item.outcome : "")).filter(([outcome]) => outcome)
    console.log(`  ${String(total).padStart(5)}  ${name.padEnd(20)} ${outcomes.map(([outcome, n]) => `${outcome} ${n}`).join(", ")}`)
  }
  const kept = verdicts.filter((item) => item.outcome.startsWith("kept"))
  console.log(`  after: ${kept.length} kept (${kept.filter((item) => item.outcome === "kept: window").length} weak), ${verdicts.length - kept.length} left out`)
}

/**
 * One turn on this Mac through the real tracker, history and rules, while
 * whatever else runs here keeps running: shell commands write outside the
 * scratch project the way a Thread's would, each reported as a harness
 * reports it, and the verdict on each is printed with the turn's summary.
 * Every file it writes is removed after.
 */
async function live(): Promise<void> {
  const sessions = await sessionCatalogs()()
  // Under a footprint root, not the per-user temporary folder the history isn't read in.
  const scratch = realpathSync(mkdtempSync("/tmp/mako-footprint-live-"))
  const project = join(scratch, "project")
  const probe = `mako-footprint-probe-${process.pid}`
  const written = {
    config: join(home, ".config", probe, "state.json"),
    named: `/tmp/${probe}.txt`,
    sibling: join(scratch, "sibling", "notes.md"),
    mentioned: `/private/tmp/${probe}-log/run.log`,
    cwd: join(project, "build", "out.txt"),
  }
  const canonical = (path: string) => (path.startsWith("/tmp/") ? `/private${path}` : path)
  mkdirSync(project, { recursive: true })
  const folder = storage(loadNoise())
  const clock = { now: () => Date.now() }
  const verdicts = new Map<string, PathVerdict>()
  const tracker = await LaptopTracker.open(
    { fs: nodeFileSystem(), events: watcherEvents(() => undefined, childHistory()), clock, storage: folder, device: "live" },
    {
      footprint: {
        home,
        roots,
        stores: () => [...harnessStores(sessions.map((session) => session.path)), ...harnessScratch(home), join(home, ".mako")],
        others: othersAt(sessions, clock.now),
        sessions: (thread) => sessionIds(sessions, thread),
        explain: (_turn, path, decided) => verdicts.set(path, decided),
      },
    },
  )
  const turn = { thread: "T-live", session: "S-live" }
  const run = (id: string, script: string, effects: ReportedEffect[]) => {
    tracker.activity({ ...turn, kind: "call", id, edge: "start", at: clock.now(), turn: "t1", cwd: project })
    const output = execFileSync("sh", ["-c", script], { cwd: project, encoding: "utf8" })
    tracker.reported({ ...turn, turn: "t1", call: id, status: "completed", effects })
    tracker.activity({ ...turn, kind: "call", id, edge: "end", at: clock.now(), turn: "t1", mentioned: output.split("\n").filter((line) => line.startsWith("/")) })
  }
  try {
    tracker.activity({ ...turn, kind: "turn", id: "t1", edge: "start", at: clock.now(), cwd: project })
    // Let the turn's mark be taken before anything is written.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    run("c1", `mkdir -p "${dirname(written.config)}" && echo '{}' > "${written.config}"`, [{ kind: "command", command: "configure the tool", cwd: project }])
    run("c2", `echo out > ${written.named}`, [{ kind: "command", command: `echo out > ${written.named}`, cwd: project, named: [written.named] }])
    run("c3", `mkdir -p ../sibling && echo notes > ../sibling/notes.md`, [{ kind: "create", path: written.sibling }])
    run("c4", `mkdir -p "${dirname(written.mentioned)}" && echo run > "${written.mentioned}" && echo "${written.mentioned}"`, [{ kind: "command", command: "run the job", cwd: project }])
    run("c5", `mkdir -p build && echo out > build/out.txt`, [{ kind: "command", command: "build", cwd: project }])
    await new Promise((resolve) => setTimeout(resolve, holdS * 1000))
    tracker.activity({ ...turn, kind: "turn", id: "t1", edge: "end", at: clock.now() })
    await tracker.settled()
    for (const [what, path] of Object.entries(written)) {
      const decided = verdicts.get(canonical(path))
      console.log(`${what.padEnd(9)} ${canonical(path).replace(home, "~")}: ${!decided ? "not read" : "rule" in decided ? `left out by ${decided.rule}` : `kept, ${decided.kept}`}`)
    }
    const [summary] = tracker.footprintTurns(turn.thread)
    if (summary) {
      console.log(`turn: history read ${summary.read} paths and left ${summary.ignored} out under rule folders (read ${summary.ms.read} ms, rules ${summary.ms.classify} ms)`)
      console.log(`kept ${summary.kept.strong} strong, ${summary.kept.weak} weak; left out ${Object.entries(summary.excluded).map(([rule, count]) => `${rule} ${count}`).join(", ")}`)
      for (const group of summary.groups.slice(0, 15)) console.log(`  left out ${String(group.count).padStart(6)}  ${group.rule.padEnd(13)} ${group.folder.replace(home, "~")}${group.why ? `  (${group.why})` : ""}`)
    }
    for (const entry of tracker.footprint(turn.thread).filter((item) => item.evidence === "weak")) console.log(`  weak ${entry.path.replace(home, "~")}`)
  } finally {
    await tracker.close()
    rmSync(folder, { recursive: true, force: true })
    rmSync(dirname(written.config), { recursive: true, force: true })
    rmSync(canonical(written.named), { force: true })
    rmSync(dirname(written.mentioned), { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (command === "learn") await learn(Number(rest[0] ?? 30))
else if (command === "replay" && rest.length) await replay(rest)
else if (command === "live") await live()
else {
  console.error("Usage: footprint-replay.ts learn <minutes> --noise <rows.json> | replay <journal.sqlite>... [--noise <rows.json>] [--out <report.json>] | live [--noise <rows.json>]")
  process.exit(1)
}
process.exit(0)
