// What the Cursor SDK's checkpoints take in an agent store, and what a collection frees (`@mako/sessions/cursor-sdk-collect`).
//   npx tsx scripts/cursor-checkpoints.ts                      dry run over this Mac's ~/.mako/cursor-sdk, read only
//   npx tsx scripts/cursor-checkpoints.ts --root <state root>  another state root (a clone of one, a test's)
//   npx tsx scripts/cursor-checkpoints.ts --root <clone> --collect   collect for real; refused on the person's own root
//   --quiet-ms <ms>  how long an agent must have been still (default 30 minutes)
import { resolve } from "node:path"
import { collectCursorCheckpoints, CURSOR_QUIET_MS, type CursorCheckpointSweep } from "@mako/sessions/cursor-sdk-collect"
import { cursorSdkStateRoot } from "@mako/sessions/cursor-sdk-paths"
import { makoUserRoot } from "@mako/sessions/mako-root"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const own = cursorSdkStateRoot(makoUserRoot())
const stateRoot = resolve(option("--root") ?? own)
const collect = args.includes("--collect")
if (collect && stateRoot === resolve(own)) throw new Error("--collect runs only on a clone (--root <clone>); Mako collects its own store when agents are quiet")
const quiet = option("--quiet-ms")
const started = performance.now()
const sweeps = collectCursorCheckpoints({
  stateRoot,
  stores: new NativeStores(!collect, collect ? stateRoot : undefined),
  dryRun: !collect,
  quietMs: quiet === undefined ? CURSOR_QUIET_MS : Number(quiet),
})
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`
const total = (pick: (sweep: CursorCheckpointSweep) => number) => sweeps.reduce((sum, sweep) => sum + pick(sweep), 0)
for (const sweep of [...sweeps].sort((left, right) => right.fileBefore - left.fileBefore)) {
  if (sweep.fileBefore < 50e6 && !sweep.deleted) continue
  console.log(
    `${sweep.directory.slice(0, 18)} ${(sweep.agentId ?? "-").padEnd(36)} ${gb(sweep.fileBefore).padStart(9)} → ${gb(collect ? sweep.fileAfter : sweep.fileBefore - sweep.deletedBytes).padStart(9)}`,
    `blobs=${sweep.blobs} roots=${sweep.roots} marked=${sweep.marked} ${collect ? "deleted" : "would delete"}=${sweep.deleted} (${gb(sweep.deletedBytes)})`,
    `${sweep.outcome}${sweep.reason ? ` (${sweep.reason})` : ""}${sweep.vacuumed ? " vacuumed" : ""} ${sweep.ms} ms`,
  )
}
const skipped = new Map<string, number>()
for (const sweep of sweeps) if (sweep.outcome === "skipped") skipped.set(sweep.reason ?? "-", (skipped.get(sweep.reason ?? "-") ?? 0) + 1)
console.log(
  `\n${sweeps.length} agents, ${gb(total((sweep) => sweep.fileBefore))};`,
  collect
    ? `after: ${gb(total((sweep) => sweep.fileAfter))}, ${total((sweep) => sweep.deleted)} roots deleted (${gb(total((sweep) => sweep.deletedBytes))})`
    : `${total((sweep) => sweep.deleted)} roots nothing names (${gb(total((sweep) => sweep.deletedBytes))})`,
  `; skipped: ${[...skipped].map(([reason, count]) => `${count} ${reason}`).join(", ") || "none"}; ${Math.round(performance.now() - started)} ms`,
)
