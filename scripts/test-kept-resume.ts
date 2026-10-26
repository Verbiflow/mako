import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageChannel } from "node:worker_threads"
import { connectDaemonPort, homePlace, SAVED_HISTORY_READERS, serveCatalogOnPort, SessionCatalog, type KeptRestore, type ThreadRef } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { createContinuationPlanner } from "@mako/host/conversations/continuation"
import { restorePlan, restoringResume, type InstalledRuntime } from "@mako/host/conversations/kept-resume"
import { recordWritersAt } from "@mako/sessions/record-store"
import type { SessionWriters } from "@mako/sessions/record-writers"
import type { ProviderBinding, ResumeVerdict } from "@mako/host/contracts/conversation-control"
import { resumeVerdict } from "@mako/host/harnesses/native-continuation"
import type { ProviderActivitySession } from "@mako/host/threads/harnesses"
import { registeredHarnessIds } from "./registered-harnesses.ts"

/**
 * A session its harness deleted, whose records Mako keeps, resumes natively:
 * the host's plan restores it into the harness's own store from the record
 * store, the harness's own verdict is asked again, and the plan reopens the
 * same session. Through the real catalog, record store and file-store
 * resume policy, on a Codex rollout and a Claude Code transcript in a
 * fixture home; then the plan's rule on every registered harness. Nothing is
 * restored while another process or another Mako host holds the session;
 * a restore asked again writes nothing; only Mako's copy goes on from its
 * transcript. Records go only into the version of their harness that wrote
 * them or a newer one: while an older one is installed, the composer's plan
 * offers its update, a reply goes on from the transcript and nothing is
 * written, and once updated the same reply resumes natively.
 */

const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex")
/** The records the fixture's sessions are made of, as Codex and Claude Code write them. */
type CodexPayload = { id: string; cwd: string; cli_version: string } | { type: "message"; role: "user" | "assistant"; content: { type: "input_text" | "output_text"; text: string }[] }
interface CodexLine { timestamp: string; type: "session_meta" | "response_item"; payload: CodexPayload }
interface ClaudeLine {
  type: "user" | "assistant"; sessionId: string; version: string; cwd: string; uuid: string; parentUuid?: string; timestamp: string
  message: { role: "user"; content: string } | { role: "assistant"; content: { type: "text"; text: string }[] }
}
const line = (value: CodexLine | ClaudeLine) => `${JSON.stringify(value)}\n`

const root = await mkdtemp(join(tmpdir(), "mako-kept-resume-"))
try {
  const home = join(root, "home")
  // A Codex rollout and a Claude Code transcript, as their harnesses write them.
  const codexId = "01a0e74f-b716-77a2-8b46-000000000007"
  const dated = join(home, ".codex", "sessions", "2026", "10", "14")
  await mkdir(dated, { recursive: true })
  const codexPath = join(dated, `rollout-2026-10-14T02-10-00-${codexId}.jsonl`)
  const stamp = (type: CodexLine["type"], payload: CodexPayload) => line({ timestamp: "2026-10-14T02:10:00.000Z", type, payload })
  await writeFile(codexPath, stamp("session_meta", { id: codexId, cwd: home, cli_version: "0.163.0" }) +
    stamp("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Remember FALCON." }] }) +
    stamp("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }))
  const claudeId = "4f6c1d2e-0000-4000-8000-000000000001"
  const project = join(home, ".claude", "projects", "-work")
  await mkdir(project, { recursive: true })
  const claudePath = join(project, `${claudeId}.jsonl`)
  await writeFile(claudePath,
    line({ type: "user", sessionId: claudeId, version: "2.1.295", cwd: home, uuid: "u1", timestamp: "2026-10-14T02:10:00.000Z", message: { role: "user", content: "Remember OSPREY." } }) +
    line({ type: "assistant", sessionId: claudeId, version: "2.1.295", cwd: home, uuid: "a1", parentUuid: "u1", timestamp: "2026-10-14T02:10:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } }))
  for (const path of [codexPath, claudePath]) await utimes(path, new Date("2026-10-14T02:10:00Z"), new Date("2026-10-14T02:10:00Z"))
  const originals = new Map([[codexPath, await sha(codexPath)], [claudePath, await sha(claudePath)]])

  // The catalog worker's catalog over that home: every reader Mako ships, read where the fixture is.
  const stores = new NativeStores(false)
  const place = homePlace(home)
  const catalog = new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(stores, place)), {
    recordsPath: join(root, "records"), recordsHome: home, cachePath: join(root, "cache.json"),
    readBack: { readers: SAVED_HISTORY_READERS, stores },
  })
  await catalog.scan()
  for (const path of originals.keys()) assert.equal(await catalog.hold(path), true, `the record store holds ${path}`)
  // Their harnesses delete them.
  for (const path of originals.keys()) await rm(path)
  await catalog.scan({ emitChanges: true })

  // The host: the harness's own verdict on a file store, with a process probe; who else holds it; the restore.
  const busy = new Map<string, ProviderActivitySession[]>()
  let otherHost: string | null = null
  const restores: KeptRestore[] = []
  // What's installed here: older than what wrote the records at first, as the restore gate weighs it.
  const installed = new Map([["codex", "0.159.3"], ["claude", "2.1.283"]])
  const wrote = new Map([["codex", "0.163.0"], ["claude", "2.1.295"]])
  const runtime = (harness: string): InstalledRuntime => ({ version: installed.get(harness) ?? null, offer: { kind: "update", runtimeId: harness, label: "Update with npm" } })
  const assess = (binding: ProviderBinding): Promise<ResumeVerdict> => resumeVerdict(binding, {
    provider: binding.provider,
    probe: async () => ({ kind: "available", sessions: busy.get(binding.provider) ?? [] }),
  })
  const resume = restoringResume({
    assess,
    ref: (path) => catalog.list().find((ref) => ref.path === path),
    heldElsewhere: () => otherHost,
    installed: runtime,
    restore: async (path, version) => {
      const restored = await catalog.restoreKept(path, version)
      restores.push(restored)
      return restored
    },
    writers: (path) => recordWritersAt(join(root, "records"), path)?.writers ?? null,
    label: (harness) => harness,
  })
  const planner = createContinuationPlanner({
    ref: async (path) => catalog.list().find((ref) => ref.path === path),
    live: () => ({ available: true, canResume: true }),
    assessResume: (ref) => resume({ id: ref.nativeId, provider: ref.harness, nativeId: ref.nativeId, path: ref.path, coveredBlocks: 0, includesBase: false }),
    nativeInstalled: () => true,
    running: () => false,
    external: () => null,
  })

  for (const [path, original] of originals) {
    const kept = catalog.list().find((ref) => ref.path === path)
    assert.ok(kept?.archived && !kept.copyOnly, `${path}: listed from its records once its harness deleted it`)

    // Something holds it: nothing is written.
    const holder: ProviderActivitySession = { nativeId: kept.nativeId, path, status: "open", detail: "a terminal" }
    busy.set(kept.harness, [holder])
    const heldByProcess = await planner.resolve(path)
    assert.equal(heldByProcess.transport, "refused", "a process with the session open refuses the reply")
    busy.clear()
    otherHost = "the installed Mako app"
    const heldByHost = await planner.resolve(path)
    assert.ok(heldByHost.transport === "refused" && heldByHost.reason.includes("the installed Mako app"), "another Mako host's hold refuses it by name")
    otherHost = null
    assert.equal(existsSync(path), false, "and nothing was restored while it was held")
    assert.equal(restores.length, 0)

    // An older version of its harness here: the composer offers the update, and a reply goes on from the transcript, writing nothing.
    const writers = recordWritersAt(join(root, "records"), path)
    assert.deepEqual(writers?.writers.record, [wrote.get(kept.harness)], `${kept.harness}: the store keeps the version its records state`)
    const offer = restorePlan(kept, writers?.writers ?? null, runtime(kept.harness))
    assert.deepEqual(offer, { kind: "update", outdated: { harness: kept.harness, wrote: { version: wrote.get(kept.harness), source: "record" }, installed: installed.get(kept.harness), offer: runtime(kept.harness).offer } }, `${kept.harness}: the plan offers the update`)
    const declined = await planner.resolve(path)
    assert.ok(declined.transport === "handoff" && declined.outdated?.wrote?.version === wrote.get(kept.harness), `${kept.harness}: a reply before the update goes on from the transcript, and says why`)
    assert.match(declined.transport === "handoff" ? declined.reason : "", new RegExp(`${kept.harness} ${wrote.get(kept.harness)!.replaceAll(".", "\\.")} wrote this session`))
    assert.equal(existsSync(path), false, "and nothing was written into the older harness's store")
    assert.equal(restores.at(-1)?.kind, "outdated")
    restores.length = 0
    // Updated: the same records restore and the same session resumes.
    installed.set(kept.harness, wrote.get(kept.harness)!)
    assert.deepEqual(restorePlan(kept, writers?.writers ?? null, runtime(kept.harness)), { kind: "native" }, "the plan turns native once the update lands")

    // The reply: restored into the harness's own store, then reopened as the same session.
    const plan = await planner.resolve(path)
    assert.deepEqual(plan, { transport: "live", provider: kept.harness, nativeId: kept.nativeId }, `${kept.harness} resumes the same session`)
    assert.equal(restores.at(-1)?.kind, "restored")
    assert.equal(await sha(path), original, "written back byte for byte where the harness keeps it")
    const listed = catalog.list().find((ref) => ref.path === path)
    assert.equal(listed?.archived, undefined, "and the harness lists it again")

    // Asked again (a live start asserts its plan): nothing is written.
    restores.length = 0
    assert.equal((await planner.plan(path)).transport, "live")
    assert.deepEqual(restores, [], "a session its harness has again is resumed as it is")
    assert.deepEqual(await catalog.restoreKept(path), { kind: "present", path }, "a restore asked again writes nothing")
  }
  // The host asks the catalog worker over the daemon's protocol, as it asks for a page.
  const channel = new MessageChannel()
  const server = serveCatalogOnPort(catalog, channel.port1, { memoryGuard: false })
  const client = await connectDaemonPort(channel.port2)
  assert.deepEqual(await client.restoreKept(codexPath), { kind: "present", path: codexPath }, "the restore crosses the worker's port")
  assert.deepEqual(await client.restoreKept(codexPath, "0.159.3"), { kind: "present", path: codexPath }, "a session its harness has again isn't restored, whatever is installed")
  assert.equal((await client.restoreKept(join(home, ".codex", "sessions", "none.jsonl"))).kind, "refused", "and a session Mako holds no records of is refused, with why")
  client.close()
  server.close()
  await catalog.stop()
  console.log("Kept resume: a Codex rollout and a Claude Code transcript their harnesses deleted are restored from Mako's records and reopen as the same session; held, nothing is written; asked again, nothing is written")
} finally {
  await rm(root, { recursive: true, force: true })
}

// The rule on every registered harness: records resume natively after a restore, Mako's copy goes on from its transcript, a failed restore says why.
for (const provider of registeredHarnessIds()) {
  const ref: ThreadRef = { harness: provider, nativeId: `${provider}-1`, path: `/home/${provider}/session`, archived: true }
  let restored = false
  let outcome: KeptRestore = { kind: "restored", path: ref.path, files: 1, rows: 0, ms: 1 }
  const resume = restoringResume({
    assess: async () => restored ? { kind: "resumable", record: "unknown" } : { kind: "unavailable", reason: "The native record is missing." },
    ref: (path) => (path === ref.path ? ref : undefined),
    heldElsewhere: () => null,
    installed: () => ({ version: "1.0.0", offer: { kind: "manual", command: `${provider} upgrade` } }),
    restore: async () => {
      restored = outcome.kind === "restored"
      return outcome
    },
    writers: () => null,
    label: (harness) => harness,
  })
  const planFor = (candidate: ThreadRef) => createContinuationPlanner({
    ref: async () => candidate,
    live: () => ({ available: true, canResume: true }),
    assessResume: (kept) => resume({ id: kept.nativeId, provider: kept.harness, nativeId: kept.nativeId, path: kept.path, coveredBlocks: 0, includesBase: false }),
    nativeInstalled: () => true, running: () => false, external: () => null,
  }).resolve(candidate.path)
  assert.deepEqual(await planFor(ref), { transport: "live", provider, nativeId: ref.nativeId }, `${provider}: kept records resume natively`)
  restored = false
  const copy = await planFor({ ...ref, copyOnly: true })
  assert.equal(copy.transport, "handoff", `${provider}: only Mako's copy goes on from its transcript`)
  assert.equal(restored, false, `${provider}: and a copy restores nothing`)
  outcome = { kind: "forked", nativeId: `${provider}-fork` }
  const forked = await planFor(ref)
  assert.ok(forked.transport === "unavailable" && forked.reason.includes("Open that one from the rail"), `${provider}: a copy that went on without Mako is left, and the fork named`)
  outcome = { kind: "refused", reason: "Mako holds no finished copy of this session's records." }
  const refused = await planFor(ref)
  assert.ok(refused.transport === "unavailable" && refused.reason === outcome.reason, `${provider}: a restore that can't happen says why`)
  outcome = { kind: "outdated", wrote: { version: "1.2.0", source: "observed" }, installed: "1.0.0" }
  const outdated = await planFor(ref)
  assert.ok(outdated.transport === "handoff" && outdated.outdated?.installed === "1.0.0" && outdated.outdated.offer.kind === "manual", `${provider}: records newer than its harness here go on from the transcript, with the update to run`)
  assert.deepEqual(restorePlan(ref, { record: [], observed: ["1.2.0"] }, { version: "1.0.0", offer: { kind: "manual" } }).kind, "update", `${provider}: and the composer's plan says so first`)
  assert.deepEqual(restorePlan(ref, { record: [], observed: [] }, { version: "1.0.0", offer: { kind: "manual" } }).kind, "update", `${provider}: a writer nothing names is gated`)
  assert.deepEqual(restorePlan(ref, { record: [], observed: [], evidence: { source: "unknown", writes: { first: 2_000, last: 3_000 }, why: "fixture", at: 0 } }, { version: "1.0.0", since: 1_000, sole: true, offer: { kind: "manual" } }).kind, "native", `${provider}: unless the only install predates every write`)
  assert.deepEqual(restorePlan(ref, { record: ["1.2.0"], observed: [] }, { version: null, offer: { kind: "manual" } }).kind, "native", `${provider}: nor does an unreadable install`)
}
console.log(`Kept resume: the rule holds on ${registeredHarnessIds().join(", ")}`)

// Records of another program that the harness's runtime imports to continue them (a `cursor-agent` store the Cursor SDK imports) go
// through the same gate while the harness still holds them: a store newer than what imports it goes on from its transcript.
{
  const ref: ThreadRef = { harness: "cursor", nativeId: "39fc58cb", path: "/home/.cursor/chats/w/39fc58cb/store.db" }
  const sdk = { version: "1.0.31", lines: { "cursor-agent": { version: "2026.09.03", reader: "Mako's @cursor/sdk 1.0.31, published 2026.09.03" } }, offer: { kind: "owner" as const, owner: "Mako" } }
  const agentStore = (upTo: string): SessionWriters => ({ record: [], observed: [], evidence: { source: "range", bound: "build-day", line: "cursor-agent", upTo, why: "fixture", at: 0 } })
  let writers = agentStore("2026.10.15")
  let assessed = 0
  const resume = restoringResume({
    assess: async () => {
      assessed += 1
      return { kind: "resumable", record: "same" }
    },
    ref: (path) => (path === ref.path ? ref : undefined),
    heldElsewhere: () => null,
    installed: () => sdk,
    restore: async () => assert.fail("a store its harness holds is never restored"),
    writers: () => writers,
    label: () => "Cursor",
  })
  const binding = { id: ref.nativeId, provider: "cursor", nativeId: ref.nativeId, path: ref.path, coveredBlocks: 0, includesBase: false }
  const newer = await resume(binding)
  assert.ok(newer.kind === "closed" && newer.outdated?.reader === sdk.lines["cursor-agent"].reader && newer.outdated.upTo === "2026.10.15" && assessed === 0, `a store written after the SDK was published isn't imported: ${JSON.stringify(newer)}`)
  assert.match(newer.kind === "closed" ? newer.reason : "", /^Mako can't tell which cursor-agent version wrote this session; it may have been as new as 2026\.10\.15, and Mako's @cursor\/sdk 1\.0\.31, published 2026.09.03, may not read it\. It goes on from its transcript\.$/)
  assert.equal(restorePlan(ref, writers, sdk).kind, "update", "the composer says so first")
  const plan = await createContinuationPlanner({
    ref: async () => ref,
    live: () => ({ available: true, canResume: true }),
    assessResume: () => resume(binding),
    nativeInstalled: () => true, running: () => false, external: () => null,
  }).resolve(ref.path)
  assert.ok(plan.transport === "handoff" && plan.outdated?.reader !== undefined, `a reply goes on from the transcript in a new session: ${JSON.stringify(plan)}`)
  writers = agentStore("2026.09.02")
  assert.deepEqual(await resume(binding), { kind: "resumable", record: "same" }, "an older store is imported as before")
  assert.equal(restorePlan(ref, writers, sdk).kind, "native")
  writers = { record: [], observed: ["1.0.31"] }
  assert.equal(restorePlan(ref, writers, sdk).kind, "none", "the SDK's own agents aren't imported")
  console.log("Kept resume: a cursor-agent store newer than the SDK that imports it goes on from its transcript; an older one is imported")
}
