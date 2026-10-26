import "./lib/scratch-git.mjs"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { homePlace, SAVED_HISTORY_READERS, SessionCatalog, type KeptRestore, type Thread } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { RecordStore, recordWritersAt } from "@mako/sessions/record-store"
import { createContinuationPlanner } from "@mako/host/conversations/continuation"
import { restoringResume } from "@mako/host/conversations/kept-resume"
import { harnessNamed, nativePath, run } from "./native-harnesses.ts"
import { storeReader } from "./decode-compare.ts"
import { scratchHarnessHome } from "./scratch-harness-home.ts"

/**
 * The agents a session started, once its harness deletes the session,
 * against the real CLIs in a scratch home (`scratch-harness-home.ts`; the
 * person's own homes and sessions are never read or written, and nothing is
 * installed). For each harness named (all six by default, and `codex-review`,
 * a `codex exec review` whose reviewer runs as a thread of its own): a real
 * session starts a subagent that replies with a codeword, the catalog's
 * record store takes it, the harness's store loses the session and its
 * children, and the rail lists it from Mako's records. Each child lists and
 * opens from there as it drew live, at the same path, with Show original.
 * Then the host's plan for a reply restores the session, its children with
 * it; the harness's own reader lists and reads them, and its own resume
 * recalls the codeword. Last the harness deletes it again, and the person's
 * delete of what Mako keeps forgets the session and its children. Times are
 * printed.
 *
 *   tsx --tsconfig tsconfig.app.json scripts/prove-kept-children.ts [harness…]
 *
 * It runs model turns on each harness's own account; the scratch home is removed afterwards.
 */

const ALL = ["claude", "codex", "codex-review", "grok", "cursor", "opencode", "devin"]
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : ALL
const data = process.env["MAKO_THREAD_DATA_DIR"] ?? "/tmp"
const scratchRoot = join(data, "kept-children-proof")
await rm(scratchRoot, { recursive: true, force: true })
const cwds = new Map(chosen.map((name) => [name, join(scratchRoot, "work", name)]))
const scratch = await scratchHarnessHome(scratchRoot, [...cwds.values()])
const { home, env } = scratch
const stores = new NativeStores(false)
const records = join(scratchRoot, "records")
const lines: string[] = []
const exec = promisify(execFile)
const ThreadStarted = z.object({ type: z.literal("thread.started"), thread_id: z.string() })

/** How a session that starts one subagent is asked for, and how a review is run. */
const subagentPrompt = (word: string) =>
  `Use your subagent tool (Agent, Task, spawn_agent, spawn_subagent, task or run_subagent, whichever you have) to start exactly one subagent whose only job is to reply with the word ${word}, without using tools. Then reply with what it returned.`

async function start(name: string, cwd: string, word: string): Promise<string> {
  if (name !== "codex-review") return (await harnessNamed(name).start(cwd, subagentPrompt(word), env)).id
  // A repository with an uncommitted change for the reviewer to read; the review's findings carry the codeword into the session.
  await exec("git", ["init", "-q"], { cwd, env })
  await writeFile(join(cwd, "words.py"), "def word():\n    return 'old'\n")
  await exec("git", ["add", "-A"], { cwd, env })
  await exec("git", ["-c", "user.email=proof@example.com", "-c", "user.name=proof", "commit", "-qm", "init"], { cwd, env })
  await writeFile(join(cwd, "words.py"), "def word():\n    return 'new'\n")
  const out = await run("codex", ["exec", "review", "--json", `Review the uncommitted changes to words.py. Begin your overall explanation with the exact word ${word}.`], cwd, env)
  const started = out.split("\n").flatMap((line) => {
    try {
      return [ThreadStarted.safeParse(JSON.parse(line)).data ?? []].flat()
    } catch {
      return []
    }
  })[0]
  if (!started?.thread_id) throw new Error(`codex review started no thread: ${out.slice(-400)}`)
  return started.thread_id
}

const recallPrompt = (name: string) => name === "codex-review"
  ? "What exact word did the review's overall explanation begin with? Reply with just that word. Don't run any tools."
  : "What word did your subagent return earlier? Reply with just that word. Don't run any tools."

const ms = (from: number) => `${Math.round(performance.now() - from)} ms`

for (const name of chosen) {
  const harness = name === "codex-review" ? "codex" : name
  const cwd = cwds.get(name)!
  await mkdir(cwd, { recursive: true })
  const note = (ok: boolean, what: string) => lines.push(`${name.padEnd(12)} ${ok ? "PASS" : "FAIL"} ${what}`)
  const word = `CHILD-${harness.toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  const reader = () => storeReader(harness, home)
  const catalog = new SessionCatalog(SAVED_HISTORY_READERS.map((each) => each(stores, homePlace(home))), {
    recordsPath: records, recordsHome: home, cachePath: join(scratchRoot, `${name}-cache.json`),
    readBack: { readers: SAVED_HISTORY_READERS, stores },
  })
  let id = ""
  let path = ""
  try {
    id = await start(name, cwd, word)
    path = await nativePath(harness, id, home)
    await catalog.scan()
    const live = await catalog.children(path)
    const located = live?.children.filter((child) => child.path) ?? []
    note(located.length > 0, `the session started ${located.length} child agent(s): ${located.map((child) => `${child.nativeId} (${child.role ?? child.title ?? "agent"})`).join(", ")}`)
    if (!located.length) continue
    const drawn = new Map<string, string>()
    const restoredHomes = new RegExp(`${join(records, "restored").replaceAll("/", "\\/")}\\/[^/]+\\/[0-9a-f]{32}`, "g")
    const shown = (thread: Thread | null) => JSON.stringify(thread?.entries ?? null).replace(restoredHomes, home)
    for (const child of located) drawn.set(child.path!, shown(await catalog.open(child.path!, false)))

    let started = performance.now()
    note(await catalog.hold(path), `the record store holds the session and its children (${ms(started)})`)
    const store = new RecordStore(records, stores)
    const linked = store.childPaths(harness, id)
    await store.close()
    note(located.every((child) => linked.includes(child.path!)), `the store links each child to it: ${linked.length}`)

    // The harness deletes the session and its children.
    for (const child of [...located].reverse()) if (!(await reader().remove?.(child.path!).catch(() => false))) await rm(child.path!, { force: true })
    if (!(await reader().remove?.(path).catch(() => false)) && !path.includes("#")) await rm(path, { force: true })
    await catalog.scan({ emitChanges: true })
    const kept = catalog.list().find((ref) => ref.nativeId === id)
    note(Boolean(kept?.archived && !kept.copyOnly) && !(await reader().read(path).catch(() => null)), "deleted by its harness, the rail lists it from Mako's records")
    if (!kept) continue
    started = performance.now()
    const listed = await catalog.children(path)
    const same = JSON.stringify(listed?.children.map((child) => [child.nativeId, child.path, child.toolId, child.state.kind])) === JSON.stringify(live?.children.map((child) => [child.nativeId, child.path, child.toolId, child.state.kind]))
    note(same, `its children list from the records as they did live (${ms(started)})`)
    for (const child of located) {
      started = performance.now()
      const thread = await catalog.open(child.path!, false)
      const opened = ms(started)
      const cited = thread?.entries.find((entry) => entry.record && entry.id)?.id
      const original = cited ? await catalog.original(child.path!, cited) : null
      note(Boolean(thread) && thread!.ref.path === child.path && shown(thread) === drawn.get(child.path!) && Boolean(original?.parts.length),
        `${child.nativeId} opens at its own path and draws as it did (${thread?.entries.length ?? 0} entries, ${opened}), Show original reads it`)
    }

    // The host's plan for a reply restores it, its children with it, and reopens the same session.
    const restores: KeptRestore[] = []
    const resume = restoringResume({
      assess: async (binding) => {
        const ref = catalog.list().find((each) => each.path === binding.path)
        return ref && !ref.archived ? { kind: "resumable", record: "unknown" } : { kind: "unavailable", reason: "The native record is missing." }
      },
      ref: (at) => catalog.list().find((ref) => ref.path === at),
      heldElsewhere: () => null,
      installed: () => ({ version: null, offer: { kind: "manual" } }),
      restore: async (at, version) => {
        const restored = await catalog.restoreKept(at, version)
        restores.push(restored)
        return restored
      },
      writers: (at) => recordWritersAt(records, at)?.writers ?? null,
      label: (each) => each,
    })
    const plan = await createContinuationPlanner({
      ref: async (at) => catalog.list().find((ref) => ref.path === at),
      live: () => ({ available: true, canResume: true }),
      assessResume: (ref) => resume({ id: ref.nativeId, provider: ref.harness, nativeId: ref.nativeId, path: ref.path, coveredBlocks: 0, includesBase: false }),
      nativeInstalled: () => true, running: () => false, external: () => null,
    }).resolve(kept.path)
    const restored = restores[0]
    note(plan.transport === "live" && restored?.kind === "restored", `the plan restores it (${restored?.kind === "restored" ? `${restored.files} files, ${restored.rows} rows in ${restored.ms} ms` : JSON.stringify(restored)})`)
    const native = (await reader().children?.(path)) ?? []
    let reads = true
    for (const child of located) reads &&= shown(await reader().read(child.path!)) === drawn.get(child.path!)
    note(located.every((child) => native.some((each) => each.nativeId === child.nativeId && each.path === child.path)) && reads, `${harness}'s own reader lists and reads its children again`)
    const recalled = await harnessNamed(harness).resume(cwd, id, recallPrompt(name), env)
    note(recalled.includes(word), `${harness}'s own resume recalls it: ${JSON.stringify(recalled.trim().slice(0, 80))}`)

    // Its harness deletes it again, and the person deletes what Mako keeps: Mako's records lose the session and its children.
    for (const child of [...located].reverse()) if (!(await reader().remove?.(child.path!).catch(() => false))) await rm(child.path!, { force: true })
    if (!(await reader().remove?.(path).catch(() => false)) && !path.includes("#")) await rm(path, { force: true })
    await catalog.scan({ emitChanges: true })
    started = performance.now()
    note(Boolean(catalog.list().find((ref) => ref.nativeId === id)?.archived) && await catalog.remove(path), `the person's delete of the kept session removes it (${ms(started)})`)
    const after = new RecordStore(records, stores)
    const forgotten = after.units(harness, id).length === 0 && located.every((child) => after.parentAt(child.path!) === null)
    await after.close()
    const gone = !(await reader().read(path).catch(() => null)) && (await Promise.all(located.map((child) => reader().read(child.path!).catch(() => null)))).every((thread) => !thread)
    note(forgotten && gone && !catalog.list().some((ref) => ref.nativeId === id) && !(await catalog.open(located[0]!.path!, false)), "and its children: neither the harness nor Mako's records hold any of it")
  } catch (error) {
    note(false, error instanceof Error ? error.message : String(error))
  } finally {
    await catalog.stop()
    if (path && existsSync(path)) await reader().remove?.(path).catch(() => undefined)
  }
}
console.log(lines.join("\n"))
if (lines.some((line) => line.includes(" FAIL "))) process.exitCode = 1
await rm(scratchRoot, { recursive: true, force: true })
