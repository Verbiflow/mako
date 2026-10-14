import { createHash } from "node:crypto"
import { mkdir, readFile, rm, stat, truncate } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { RecordStore } from "../packages/sessions/src/record-store.ts"
import { storeReader } from "./decode-compare.ts"
import { HARNESSES, harnessNamed, nativePath as findSession, removeSession, type Harness } from "./native-harnesses.ts"

/**
 * The record store against the harnesses themselves, on this machine's
 * sign-ins. For each harness: a real session plants a codeword, a resume
 * plants a second, and each turn is captured. The session is deleted from
 * the harness's store, restored from Mako's, and resumed natively, which
 * must recall both. Where a session is an append-only file, its transcript
 * is cut back to the first version and restored by appending, then cut back
 * and continued with another turn, which the restore must leave untouched.
 *
 *   tsx --tsconfig tsconfig.app.json scripts/prove-native-restore.ts [--store <dir>] [harness…]
 *
 * It runs model turns on each harness's own account and deletes its test
 * sessions afterwards.
 */

const args = process.argv.slice(2)
const storeAt = args.indexOf("--store")
const folder = storeAt >= 0 ? args.splice(storeAt, 2)[1]! : join(process.env["MAKO_THREAD_DATA_DIR"] ?? "/tmp", "native-restore-proof")
const home = homedir()
const nativeStores = new NativeStores(false)
const store = new RecordStore(folder, nativeStores)
const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex")

const nativePath = (harness: string, id: string) => findSession(harness, id, home)

async function capture(harness: string, id: string, path: string) {
  const records = await storeReader(harness, home).records(path)
  if (!records) throw new Error(`${harness} keeps no records at ${path}`)
  return store.capture({ harness, nativeId: id, home, records })
}

/** The session's main transcript: the append-only file its path names, or under it. */
function transcriptUnit(harness: string, id: string): { key: string; path: string } | null {
  const unit = store.units(harness, id).find((candidate) => candidate.role === "file" && candidate.path && candidate.key.includes(id) && /\.(?:jsonl|ndjson)$/.test(candidate.key) && !candidate.key.includes("/subagents/"))
    ?? store.units(harness, id).find((candidate) => candidate.role === "file" && candidate.path?.endsWith("updates.jsonl"))
  return unit?.path ? { key: unit.key, path: join(home, unit.path.replace(/\.zst$/, "")) } : null
}

async function prove(harness: string, spec: Harness): Promise<string[]> {
  const steps: string[] = []
  const note = (ok: boolean, what: string) => steps.push(`${ok ? "PASS" : "FAIL"} ${what}`)
  const cwd = join("/tmp", `mako-restore-${harness}`)
  await rm(cwd, { recursive: true, force: true })
  await mkdir(cwd, { recursive: true })
  const word = (label: string) => `${label}-${harness.toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const first = word("ALPHA")
  const second = word("BRAVO")
  const third = word("CHARLIE")
  const ask = "What codewords have I asked you to remember in this conversation? Reply with just the codewords, comma-separated. Don't run any tools."
  let id = ""
  let path = ""
  try {
    ;({ id } = await spec.start(cwd, `Remember this codeword for later: ${first}. Reply with just OK. Don't run any tools.`))
    path = await nativePath(harness, id)
    const v1 = await capture(harness, id, path)
    note(v1.versions.length > 0, `first turn captured: ${v1.versions.length} versions, ${v1.newChunks} chunks, ${v1.ms} ms`)
    const transcript = spec.appends ? transcriptUnit(harness, id) : null
    const firstSize = transcript ? (await stat(transcript.path)).size : 0

    await spec.resume(cwd, id, `Also remember this second codeword: ${second}. Reply with just OK. Don't run any tools.`)
    const v2 = await capture(harness, id, await nativePath(harness, id))
    const kinds = [...new Set(v2.versions.map((version) => version.kind))].join(", ")
    note(v2.versions.length > 0 && (!spec.appends || v2.versions.some((version) => version.kind === "append" && version.unit === transcript?.key)), `second turn captured as ${v2.versions.length} versions (${kinds})`)

    const removed = await storeReader(harness, home).remove(path)
    if (!removed) await rm(harness === "cursor" ? dirname(path) : path, { recursive: true, force: true })
    const gone = !(await storeReader(harness, home).discover()).some((file) => file.path.includes(id))
    note(gone, "deleted from the harness's own store")
    const restored = await store.restore({ harness, nativeId: id, home })
    note(restored.written && !restored.diverged.length, `restored whole: ${restored.actions.filter((action) => action.action !== "skip").length} units written${restored.diverged.length ? `, diverged at ${restored.diverged[0]!.unit}: ${restored.diverged[0]!.reason}` : ""}`)
    const recalled = await spec.resume(cwd, id, ask)
    note(recalled.includes(first) && recalled.includes(second), `native resume after restore recalls both codewords: ${JSON.stringify(recalled.trim().slice(0, 120))}`)

    if (spec.appends && transcript) {
      await capture(harness, id, await nativePath(harness, id))
      await truncate(transcript.path, firstSize)
      const onto = await store.restore({ harness, nativeId: id, home })
      note(onto.actions.some((action) => action.action === "append" && action.unit === transcript.key) && !onto.diverged.length, `a copy cut back to the first turn is restored by appending (${[...new Set(onto.actions.map((action) => action.action))].join(", ")})`)
      const again = await spec.resume(cwd, id, ask)
      note(again.includes(first) && again.includes(second), `native resume after the append recalls both: ${JSON.stringify(again.trim().slice(0, 120))}`)

      await capture(harness, id, await nativePath(harness, id))
      await truncate(transcript.path, firstSize)
      await spec.resume(cwd, id, `Remember this codeword instead: ${third}. Reply with just OK. Don't run any tools.`)
      const before = await sha(transcript.path)
      const diverged = await store.restore({ harness, nativeId: id, home })
      const after = await sha(transcript.path)
      note(!diverged.written && diverged.diverged.some((entry) => entry.unit === transcript.key) && before === after, `a copy that went on without Mako is left untouched (${diverged.diverged.length} units diverged)`)
    }
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
  if (lines.some((line) => line.includes(" FAIL "))) process.exitCode = 1
} finally {
  await store.close()
}
