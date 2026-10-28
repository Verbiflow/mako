import { mkdtempSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { defaultCatalog } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { RecordStore } from "../packages/sessions/src/record-store.ts"
import { HARNESSES, harnessNamed, nativePath, removeSession, type Harness } from "./native-harnesses.ts"
import { enterScratchHome } from "./scratch-harness-home.ts"

/**
 * Capture as Mako runs it: the catalog every host and daemon builds, over a
 * scratch home signed in as this machine's person (`enterScratchHome`), so the
 * sessions it makes never reach their own stores, keeping its record store in
 * a scratch folder. Each
 * harness's CLI starts a session and continues it, and after each turn the
 * store must hold the session as the harness left it: a dry-run restore into
 * the same home finds every unit already there. Prints how long after each
 * CLI exited the store caught up, each session's captures, and what else on
 * the machine was captured meanwhile.
 *
 *   tsx --tsconfig tsconfig.app.json scripts/prove-record-capture.ts [--store <dir>] [harness…]
 *
 * It runs model turns on each harness's own account, and deletes its test
 * sessions and the scratch home afterwards.
 */

const CAUGHT_UP_MS = 60_000

const args = process.argv.slice(2)
const storeAt = args.indexOf("--store")
const folder = storeAt >= 0 ? args.splice(storeAt, 2)[1]! : join(process.env["MAKO_THREAD_DATA_DIR"] ?? "/tmp", "record-capture-proof")
const scratchRoot = mkdtempSync(join(tmpdir(), "mako-record-capture-"))
const { env, dispose } = enterScratchHome(scratchRoot)
const home = homedir()
await rm(folder, { recursive: true, force: true })

const started = performance.now()
const catalog = defaultCatalog({ recordsPath: folder })
const listed = await catalog.scan()
catalog.startWatching()
console.log(`catalog: ${listed.length} sessions discovered in ${Math.round(performance.now() - started)} ms; capture starts with the next write`)
const look = new RecordStore(folder, new NativeStores(false))

/** How long after `since` a dry-run restore first found the session whole in the store, or the plan that still differed. */
async function caughtUp(harness: string, id: string, since: number): Promise<{ ms: number } | { pending: string }> {
  let pending = "nothing captured"
  while (Date.now() - since < CAUGHT_UP_MS) {
    const plan = await look.restore({ harness, nativeId: id, home, dryRun: true })
    const writes = [
      ...plan.actions.filter((action) => action.action !== "skip").map((action) => `${action.action} ${action.unit}`),
      ...plan.rows.filter((rows) => rows.insert + rows.replace + rows.delete).map((rows) => `${rows.insert + rows.replace + rows.delete} rows of ${rows.path} ${rows.table}`),
    ]
    const held = plan.actions.length + plan.rows.length
    if (held && !writes.length && !plan.diverged.length) return { ms: Date.now() - since }
    if (held) pending = [...writes, ...plan.diverged.map((entry) => `diverged ${entry.unit}: ${entry.reason}`)].slice(0, 3).join("; ")
    await new Promise((done) => setTimeout(done, 100))
  }
  return { pending }
}

async function prove(harness: string, spec: Harness): Promise<string[]> {
  const steps: string[] = []
  const note = (ok: boolean, what: string) => steps.push(`${ok ? "PASS" : "FAIL"} ${what}`)
  const cwd = join("/tmp", `mako-capture-${harness}`)
  await rm(cwd, { recursive: true, force: true })
  await mkdir(cwd, { recursive: true })
  let id = ""
  try {
    const turns = [
      "Remember this codeword for later: ALPHA-CAPTURE. Reply with just OK. Don't run any tools.",
      "Also remember BRAVO-CAPTURE. Reply with just OK. Don't run any tools.",
    ]
    for (const [index, prompt] of turns.entries()) {
      if (index === 0) ({ id } = await spec.start(cwd, prompt, env))
      else await spec.resume(cwd, id, prompt, env)
      const exited = Date.now()
      if (index === 0) await nativePath(harness, id, home)
      const result = await caughtUp(harness, id, exited)
      note("ms" in result, "ms" in result ? `turn ${index + 1} in the store ${result.ms} ms after the CLI exited` : `turn ${index + 1} not in the store after ${CAUGHT_UP_MS / 1000} s: ${result.pending}`)
    }
    const captures = look.captures({ harness, nativeId: id, limit: 1000 }).reverse()
    note(captures.length > 0, `${captures.length} captures: ${captures.map((capture) => `${capture.versions}v/${capture.ms}ms${capture.waitedMs ? `+${capture.waitedMs}ms waiting` : ""}`).join(" ")}`)
  } catch (error) {
    note(false, error instanceof Error ? error.message : String(error))
  } finally {
    if (id) await removeSession(harness, id, home)
    await rm(cwd, { recursive: true, force: true })
  }
  return steps.map((step) => `${harness.padEnd(8)} ${step}`)
}

const chosen = args.length ? args : Object.keys(HARNESSES)
try {
  const results = await Promise.all(chosen.map((harness) => prove(harness, harnessNamed(harness))))
  const lines = results.flat()
  console.log(lines.join("\n"))
  const others = look.captures({ limit: 100_000 })
  const slowest = others.reduce((worst, capture) => (capture.ms > (worst?.ms ?? -1) ? capture : worst), others[0])
  const stats = look.stats()
  console.log(`store: ${stats.sessions} sessions, ${stats.units} units, ${(stats.bytes / 2 ** 20).toFixed(1)} MiB → ${(stats.stored / 2 ** 20).toFixed(1)} MiB stored; ${others.length} logged captures${slowest ? `, the slowest ${slowest.ms} ms (${slowest.harness} ${slowest.nativeId}, ${slowest.versions} versions)` : ""}`)
  if (lines.some((line) => line.includes(" FAIL "))) process.exitCode = 1
} finally {
  const stopping = performance.now()
  await catalog.stop()
  console.log(`catalog stopped in ${Math.round(performance.now() - stopping)} ms, its last captures flushed`)
  await look.close()
  dispose()
  await rm(scratchRoot, { recursive: true, force: true })
}
