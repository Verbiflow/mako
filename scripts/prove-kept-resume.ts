import { rm, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { keptOutputsPath, SAVED_HISTORY_READERS, SessionCatalog, type KeptRestore } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { recordWritersAt } from "@mako/sessions/record-store"
import { createContinuationPlanner } from "@mako/host/conversations/continuation"
import { restoringResume } from "@mako/host/conversations/kept-resume"
import { HARNESSES, harnessNamed, nativePath, removeSession } from "./native-harnesses.ts"
import { scratchHarnessHome } from "./scratch-harness-home.ts"

/**
 * A session its harness deleted, resumed natively through Mako, against the
 * real CLIs in a scratch home (`scratch-harness-home.ts`; the person's own
 * homes and sessions are never read or written). For each harness named
 * (Claude Code by default, the realistic case: it deletes transcripts after
 * 30 days): a real session plants a codeword, the catalog's record store
 * takes it, the session is deleted from the harness's store, and the rail
 * lists it from Mako's records. Then the host's plan for a reply restores it
 * into the harness's own store and reopens it, and the harness's own resume
 * must recall the codeword.
 *
 *   tsx --tsconfig tsconfig.app.json scripts/prove-kept-resume.ts [harness…]
 *
 * It runs model turns on each harness's own account; the scratch home is removed afterwards.
 */

const chosen = process.argv.slice(2).length ? process.argv.slice(2) : ["claude"]
const data = process.env["MAKO_THREAD_DATA_DIR"] ?? "/tmp"
const scratchRoot = join(data, "kept-resume-proof")
await rm(scratchRoot, { recursive: true, force: true })
const cwds = new Map(chosen.map((harness) => [harness, join(scratchRoot, "work", harness)]))
const scratch = await scratchHarnessHome(scratchRoot, [...cwds.values()])
if (scratch.expiresInHours < 0.5) throw new Error("A credential the scratch home holds expires within half an hour; sign the harness in again first")
const { home, env } = scratch
const stores = new NativeStores(false)
const lines: string[] = []

for (const harness of chosen) {
  if (!(harness in HARNESSES)) throw new Error(`No harness ${harness}`)
  const spec = harnessNamed(harness)
  const cwd = cwds.get(harness)!
  await mkdir(cwd, { recursive: true })
  const note = (ok: boolean, what: string) => lines.push(`${harness.padEnd(8)} ${ok ? "PASS" : "FAIL"} ${what}`)
  const word = `KEPT-${harness.toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  let id = ""
  const catalog = new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(stores, { home, kept: keptOutputsPath(home) })), {
    recordsPath: join(scratchRoot, "records"), recordsHome: home, cachePath: join(scratchRoot, `${harness}-cache.json`),
    readBack: { readers: SAVED_HISTORY_READERS, stores },
  })
  try {
    ;({ id } = await spec.start(cwd, `Remember this codeword for later: ${word}. Reply with just OK. Don't run any tools.`, env))
    const path = await nativePath(harness, id, home)
    await catalog.scan()
    note(await catalog.hold(path), "the record store holds the session")
    // The harness deletes it, as Claude Code does after 30 days.
    await removeSession(harness, id, home)
    await catalog.scan({ emitChanges: true })
    const kept = catalog.list().find((ref) => ref.nativeId === id)
    note(Boolean(kept?.archived && !kept.copyOnly && !existsSync(path)), "deleted by its harness, the rail lists it from Mako's records")
    if (!kept) continue

    // The host's plan for a reply: restore, then reopen the same session.
    const restores: KeptRestore[] = []
    const resume = restoringResume({
      // The harness's verdict: whether its store has the session now, as the catalog reads that store. (A driver reads its own
      // store the same way; this script runs no driver, so a database store's session isn't judged as a file.)
      assess: async (binding) => {
        const listed = catalog.list().find((ref) => ref.path === binding.path)
        return listed && !listed.archived ? { kind: "resumable", record: "unknown" } : { kind: "unavailable", reason: "The native record is missing." }
      },
      ref: (at) => catalog.list().find((ref) => ref.path === at),
      heldElsewhere: () => null,
      // The version gate is `prove-restore-versions.ts`'s: here what's installed is what wrote the session.
      installed: () => ({ version: null, offer: { kind: "manual" } }),
      restore: async (at, version) => {
        const restored = await catalog.restoreKept(at, version)
        restores.push(restored)
        return restored
      },
      writers: (at) => recordWritersAt(join(scratchRoot, "records"), at)?.writers ?? null,
      label: (name) => name,
    })
    const plan = await createContinuationPlanner({
      ref: async (at) => catalog.list().find((ref) => ref.path === at),
      live: () => ({ available: true, canResume: true }),
      assessResume: (ref) => resume({ id: ref.nativeId, provider: ref.harness, nativeId: ref.nativeId, path: ref.path, coveredBlocks: 0, includesBase: false }),
      nativeInstalled: () => true, running: () => false, external: () => null,
    }).resolve(kept.path)
    const restored = restores[0]
    note(plan.transport === "live" && plan.provider === harness && "nativeId" in plan && plan.nativeId === id && restored?.kind === "restored",
      `the plan restores it (${restored?.kind === "restored" ? `${restored.files} files, ${restored.rows} rows in ${restored.ms} ms` : JSON.stringify(restored)}) and reopens the same session: ${JSON.stringify(plan)}`)
    const recalled = await spec.resume(cwd, id, "What codeword did I ask you to remember? Reply with just the codeword. Don't run any tools.", env)
    note(recalled.includes(word), `${harness}'s own resume recalls it: ${JSON.stringify(recalled.trim().slice(0, 80))}`)
  } catch (error) {
    note(false, error instanceof Error ? error.message : String(error))
  } finally {
    await catalog.stop()
    if (id) await removeSession(harness, id, home).catch(() => undefined)
  }
}
console.log(lines.join("\n"))
if (lines.some((line) => line.includes(" FAIL "))) process.exitCode = 1
await rm(scratchRoot, { recursive: true, force: true })
