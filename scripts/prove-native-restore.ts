import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rm, stat, truncate } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { devinExecutable } from "@mako/host/harnesses/devin/executable"
import { RecordStore } from "../packages/sessions/src/record-store.ts"
import { storeReader } from "./decode-compare.ts"

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
const devin = devinExecutable() ?? "devin"

interface Harness {
  /** Starts a session in `cwd`; its native id. */
  start(cwd: string, prompt: string): Promise<{ id: string; out: string }>
  resume(cwd: string, id: string, prompt: string): string
  /** The appended transcript a cut-back copy is made from, when the session is one. */
  appends?: true
}

function run(command: string, argv: string[], cwd: string, input?: string): string {
  const out = spawnSync(command, argv, { cwd, input, encoding: "utf8", maxBuffer: 1 << 26, timeout: 600_000 })
  if (out.status !== 0) throw new Error(`${command} ${argv.slice(0, 3).join(" ")} exited ${out.status}: ${(out.stderr || out.stdout).slice(-800)}`)
  return out.stdout
}

const jsonLines = (out: string) => out.split("\n").flatMap((line) => {
  try {
    return [JSON.parse(line)]
  } catch {
    return []
  }
})

const HARNESSES: Record<string, Harness> = {
  claude: {
    appends: true,
    async start(cwd, prompt) {
      const out = run("claude", ["-p", prompt, "--output-format", "json"], cwd)
      return { id: JSON.parse(out).session_id, out }
    },
    resume: (cwd, id, prompt) => JSON.parse(run("claude", ["-p", "--resume", id, prompt, "--output-format", "json"], cwd)).result,
  },
  codex: {
    appends: true,
    async start(cwd, prompt) {
      const out = run("codex", ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", prompt], cwd)
      return { id: jsonLines(out).find((event) => event.type === "thread.started").thread_id, out }
    },
    resume: (cwd, id, prompt) => jsonLines(run("codex", ["exec", "resume", id, "--json", "--skip-git-repo-check", prompt], cwd))
      .filter((event) => event.type === "item.completed" && event.item.type === "agent_message").map((event) => event.item.text).join("\n"),
  },
  cursor: {
    async start(cwd, prompt) {
      const out = run("cursor-agent", ["-p", "--output-format", "json", "--trust", prompt], cwd)
      return { id: JSON.parse(out).session_id, out }
    },
    resume: (cwd, id, prompt) => JSON.parse(run("cursor-agent", ["-p", "--output-format", "json", "--trust", "--resume", id, prompt], cwd)).result,
  },
  opencode: {
    async start(cwd, prompt) {
      const out = run("opencode", ["run", "--format", "json", prompt], cwd)
      return { id: jsonLines(out).find((event) => event.sessionID)?.sessionID, out }
    },
    resume: (cwd, id, prompt) => jsonLines(run("opencode", ["run", "--format", "json", "-s", id, prompt], cwd))
      .filter((event) => event.type === "text").map((event) => event.part?.text ?? "").join("\n"),
  },
  grok: {
    appends: true,
    async start(cwd, prompt) {
      const id = randomUUID()
      const out = run("grok", ["-p", prompt, "-s", id, "--always-approve"], cwd)
      return { id, out }
    },
    resume: (cwd, id, prompt) => run("grok", ["-r", id, "-p", prompt, "--always-approve"], cwd),
  },
  devin: {
    async start(cwd, prompt) {
      const out = run(devin, ["-p", prompt, "--respect-workspace-trust", "false"], cwd)
      const listed = run(devin, ["list", "--format", "json"], cwd)
      const sessions = JSON.parse(listed) as { id: string }[]
      return { id: sessions[0]!.id, out }
    },
    resume: (cwd, id, prompt) => run(devin, ["-r", id, "-p", prompt, "--respect-workspace-trust", "false"], cwd),
  },
}

const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex")

async function nativePath(harness: string, id: string): Promise<string> {
  const reader = storeReader(harness, home)
  for (let attempt = 0; attempt < 20; attempt++) {
    const found = (await reader.discover()).find((file) => file.path.includes(id))
    if (found) return found.path
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error(`${harness} lists no session ${id}`)
}

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

    spec.resume(cwd, id, `Also remember this second codeword: ${second}. Reply with just OK. Don't run any tools.`)
    const v2 = await capture(harness, id, await nativePath(harness, id))
    const kinds = [...new Set(v2.versions.map((version) => version.kind))].join(", ")
    note(v2.versions.length > 0 && (!spec.appends || v2.versions.some((version) => version.kind === "append" && version.unit === transcript?.key)), `second turn captured as ${v2.versions.length} versions (${kinds})`)

    const removed = await storeReader(harness, home).remove(path)
    if (!removed) await rm(harness === "cursor" ? dirname(path) : path, { recursive: true, force: true })
    const gone = !(await storeReader(harness, home).discover()).some((file) => file.path.includes(id))
    note(gone, "deleted from the harness's own store")
    const restored = await store.restore({ harness, nativeId: id, home })
    note(restored.written && !restored.diverged.length, `restored whole: ${restored.actions.filter((action) => action.action !== "skip").length} units written${restored.diverged.length ? `, diverged at ${restored.diverged[0]!.unit}: ${restored.diverged[0]!.reason}` : ""}`)
    const recalled = spec.resume(cwd, id, ask)
    note(recalled.includes(first) && recalled.includes(second), `native resume after restore recalls both codewords: ${JSON.stringify(recalled.trim().slice(0, 120))}`)

    if (spec.appends && transcript) {
      await capture(harness, id, await nativePath(harness, id))
      await truncate(transcript.path, firstSize)
      const onto = await store.restore({ harness, nativeId: id, home })
      note(onto.actions.some((action) => action.action === "append" && action.unit === transcript.key) && !onto.diverged.length, `a copy cut back to the first turn is restored by appending (${[...new Set(onto.actions.map((action) => action.action))].join(", ")})`)
      const again = spec.resume(cwd, id, ask)
      note(again.includes(first) && again.includes(second), `native resume after the append recalls both: ${JSON.stringify(again.trim().slice(0, 120))}`)

      await capture(harness, id, await nativePath(harness, id))
      await truncate(transcript.path, firstSize)
      spec.resume(cwd, id, `Remember this codeword instead: ${third}. Reply with just OK. Don't run any tools.`)
      const before = await sha(transcript.path)
      const diverged = await store.restore({ harness, nativeId: id, home })
      const after = await sha(transcript.path)
      note(!diverged.written && diverged.diverged.some((entry) => entry.unit === transcript.key) && before === after, `a copy that went on without Mako is left untouched (${diverged.diverged.length} units diverged)`)
    }
  } catch (error) {
    note(false, error instanceof Error ? error.message : String(error))
  } finally {
    if (id) {
      const left = (await storeReader(harness, home).discover().catch(() => [])).find((file) => file.path.includes(id))
      if (left && !(await storeReader(harness, home).remove(left.path).catch(() => false))) await rm(harness === "cursor" ? dirname(left.path) : left.path, { recursive: true, force: true })
    }
    await rm(cwd, { recursive: true, force: true })
  }
  return steps.map((step) => `${harness.padEnd(8)} ${step}`)
}

const chosen = args.length ? args : Object.keys(HARNESSES)
try {
  const results = await Promise.all(chosen.map((harness) => prove(harness, HARNESSES[harness]!)))
  const lines = results.flat()
  console.log(lines.join("\n"))
  if (lines.some((line) => line.includes(" FAIL "))) process.exitCode = 1
} finally {
  await store.close()
}
