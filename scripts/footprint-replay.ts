// One turn's footprint on this Mac through the real tracker, history and
// rules, while whatever else runs here keeps running:
//
//   npx tsx scripts/footprint-replay.ts [--hold <seconds>]
//
// Commands write a new `~/.config` folder no call names, a named `/tmp`
// file, a sibling folder's file, a path only their output mentions and a
// file in the folder they run in; then it removes them. The history is read
// only under what the turn claimed, so the `~/.config` file is never read
// and the rest are kept, each with its basis. Nothing here writes to a
// host's journal or a store: the journal is a temporary one.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ReportedEffect } from "@mako/protocol"
import { SessionCatalog, translatorBuild } from "@mako/sessions"
import type { PathVerdict } from "@mako/host/attribution/footprint-reader"
import { harnessScratch, harnessStores, sessionFolders, sessionIds, type CataloguedSession } from "@mako/host/attribution/index"
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
/** How long the turn stays open after the writes, as the machine goes on. */
const holdS = Number(option("--hold") ?? 2)
const [command] = args
const home = homedir()
const roots = [home, "/private/tmp"]

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

/**
 * One turn on this Mac through the real tracker, history and rules, while
 * whatever else runs here keeps running: shell commands write outside the
 * scratch project the way a Thread's would, each reported as a harness
 * reports it, and the verdict on each is printed with the turn's summary.
 * Every file it writes is removed after.
 */
async function live(): Promise<void> {
  const sessions = await sessionCatalogs()()
  // Under `/tmp`, where a Thread's scratch work usually goes.
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
  const folder = mkdtempSync(join(tmpdir(), "mako-footprint-replay-"))
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
      console.log(`turn: history read ${summary.read} paths under its claims and left ${summary.ignored} out under checkouts and stores (read ${summary.ms.read} ms, rules ${summary.ms.classify} ms)`)
      console.log(`kept ${summary.kept.strong}; left out ${Object.entries(summary.excluded).map(([rule, count]) => `${rule} ${count}`).join(", ") || "nothing"}`)
      for (const group of summary.groups.slice(0, 15)) console.log(`  left out ${String(group.count).padStart(6)}  ${group.rule.padEnd(13)} ${group.folder.replace(home, "~")}${group.why ? `  (${group.why})` : ""}`)
    }
  } finally {
    await tracker.close()
    rmSync(folder, { recursive: true, force: true })
    rmSync(dirname(written.config), { recursive: true, force: true })
    rmSync(canonical(written.named), { force: true })
    rmSync(dirname(written.mentioned), { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (command === undefined || command === "live") await live()
else {
  console.error("Usage: footprint-replay.ts [--hold <seconds>]")
  process.exit(1)
}
process.exit(0)
