import "./lib/scratch-git.mjs"
import { Git } from "@mako/git"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadEnvironments, applyThreadEnvironment, threadEnvironmentInstructions } from "@mako/host/workspaces/thread-environment"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { mock } from "node:test"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { ThreadScratch } from "@mako/host/workspaces/thread-scratch"
import { openWorkspaces } from "@mako/host/workspaces"
import { commandEnvironment } from "@mako/host/workspaces/environment-tools"
import { ThreadArchives } from "@mako/host/threads/archives"
import { threadArchiveKey } from "@mako/host/contracts/thread-lifecycle"
import { HostJobs } from "@mako/host/base/host-jobs"
import { SessionIdSchema } from "@mako/host/contracts/thread-identity"

const root = await realpath(await mkdtemp(join(tmpdir(), "mako-thread-scratch-")))
const thread = ThreadIdSchema.parse(randomUUID())
const data = join(root, "thread-data"), registry = join(root, "scratch-owners")
let now = 1_000_000, owner: { quietAt: number; finishedAt?: number } | undefined = { quietAt: now, finishedAt: now }
let files: string[] | undefined = [], users: string[] = [], measured: (() => void) | undefined
const scratch = new ThreadScratch({
  root: data, registry, settings: join(root, "settings.json"), now: () => now,
  owner: () => owner, using: async () => users,
  openFiles: async () => { if (!files) throw new Error("Unavailable"); return files },
  privateBytes: async () => { measured?.(); return 64 },
})
const exists = (path: string) => access(path).then(() => true, () => false)
const inspect = async () => (await scratch.preview()).entries[0]!
try {
  assert.equal((await scratch.settings()).mode, "preview")
  const [path, same] = await Promise.all([scratch.ensure(thread), scratch.ensure(thread)])
  assert.equal(path, same, "concurrent launch preparation shares the same root acquisition")
  await writeFile(join(dirname(path), "kept-proof"), "not scratch")
  await writeFile(join(path, "payload"), "scratch")
  assert.equal((await inspect()).eligible, true)
  await scratch.run()
  assert.equal(await exists(path), true, "preview mode never deletes even eligible scratch")

  await scratch.configure({ mode: "remove", idleDays: 7, kept: [thread] })
  assert.equal((await inspect()).reason, "Explicitly kept.")
  await scratch.configure({ mode: "remove", idleDays: 7, kept: [] })
  await writeFile(join(path, ".keep"), "")
  assert.equal((await inspect()).eligible, false)
  await rm(join(path, ".keep"))
  owner = undefined
  assert.equal((await inspect()).eligible, false, "active/cloud/unknown ownership is not idle")
  owner = { quietAt: now, finishedAt: now - 1 }
  assert.equal((await inspect()).eligible, false, "a finish before acquisition cannot retire a new launch root")
  owner = { quietAt: now }
  assert.equal((await inspect()).eligible, false)
  now += 8 * 86_400_000
  assert.equal((await inspect()).eligible, true, "known quiet ownership ages against the original use time")
  files = [join(path, "payload")]
  assert.equal((await inspect()).eligible, false)
  files = undefined
  assert.equal((await inspect()).eligible, false, "an unavailable lsof snapshot is not empty")
  files = []; users = ["terminal"]
  assert.equal((await inspect()).eligible, false)
  users = []
  measured = () => { owner = { quietAt: now } }
  assert.equal((await inspect()).eligible, false, "a new activity fact while measurement awaits invalidates the plan")
  measured = undefined; owner = { quietAt: now, finishedAt: now }

  const nested = join(path, "worlds"); await mkdir(nested)
  const receipt = join(nested, "bench.owner.json")
  await writeFile(receipt, JSON.stringify({ pid: process.pid }))
  assert.equal((await inspect()).eligible, false, "a live receipt owner holds scratch even with no open files")
  const probe = mock.method(process, "kill", (_pid: number, signal?: string | number) => {
    assert.equal(signal, 0, "receipt inspection never sends a destructive signal")
    throw Object.assign(new Error("fixture"), { code: "EPERM" })
  })
  try {
    assert.equal((await inspect()).eligible, false, "unknown process absence is a hold")
    probe.mock.mockImplementation(() => { throw Object.assign(new Error("fixture"), { code: "ESRCH" }) })
    assert.equal((await inspect()).eligible, true, "only positive ESRCH releases a receipt hold")
  } finally { probe.mock.restore() }
  await writeFile(receipt, "{}")
  assert.equal((await inspect()).eligible, false, "a malformed receipt is not absence")
  await rm(receipt)

  const outside = join(root, "outside")
  await mkdir(outside); await writeFile(join(outside, "proof"), "outside")
  await symlink(outside, join(path, "linked"))
  const report = await scratch.run()
  assert.equal(report.entries[0]?.removed, true)
  assert.equal(await exists(path), false)
  assert.equal(await readFile(join(outside, "proof"), "utf8"), "outside", "nested links never turn into foreign cleanup")
  assert.equal(await readFile(join(dirname(path), "kept-proof"), "utf8"), "not scratch", "the Thread's durable data survives")

  // A complete acquisition survives a process loss without adopting any unregistered world.
  const abandoned = ThreadIdSchema.parse(randomUUID())
  const abandonedPath = await scratch.ensure(abandoned)
  await writeFile(join(abandonedPath, "unfinished-run"), "fixture")
  const restarted = new ThreadScratch({
    root: data, registry, settings: join(root, "settings.json"), now: () => now,
    owner: () => owner, using: async () => users,
    openFiles: async () => { if (!files) throw new Error("Unavailable"); return files },
    privateBytes: async () => 64,
  })
  try {
    files = [join(abandonedPath, "unfinished-run")]
    await restarted.run()
    assert.equal(await exists(abandonedPath), true, "restart holds a process's open scratch")
    files = []
    const recovered = await restarted.run()
    assert.equal(recovered.entries.find(row => row.thread === abandoned)?.removed, true, "restart retires completed ownership of a finished run")
  } finally { restarted.close() }

  const recreated = await scratch.ensure(thread)
  const before = (await inspect()).generation
  assert.ok(before)
  await rename(recreated, `${recreated}-old`)
  await mkdir(recreated)
  assert.equal((await inspect()).eligible, false, "a replacement cannot reuse ownership")
  await assert.rejects(scratch.ensure(thread), /replaced/)

  const legacy = ThreadIdSchema.parse(randomUUID()), legacyPath = scratch.path(legacy)
  await mkdir(legacyPath, { recursive: true }); await writeFile(join(legacyPath, "important"), "legacy")
  await assert.rejects(scratch.ensure(legacy), /unregistered/)
  assert.equal(await readFile(join(legacyPath, "important"), "utf8"), "legacy")
  assert.equal(await exists(join(registry, `${legacy}.json`)), false, "legacy roots are not silently registered")

  const interrupted = ThreadIdSchema.parse(randomUUID())
  const pendingPath = await scratch.ensure(interrupted)
  const note = join(registry, `${interrupted}.json`)
  const record = JSON.parse(await readFile(note, "utf8"))
  await writeFile(note, JSON.stringify({ ...record, retiring: true }))
  await rename(pendingPath, join(dirname(pendingPath), `.scratch-retiring-${record.generation}`))
  const pending = (await scratch.preview()).entries.find(row => row.thread === interrupted)
  assert.equal(pending?.eligible, false)
  assert.ok(pending?.retainedPath?.endsWith(record.generation))
  await assert.rejects(scratch.ensure(interrupted), /incomplete|replaced/)
  assert.equal(await exists(pendingPath), false, "an unconfirmed generation is not recreated")

  const partial = ThreadIdSchema.parse(randomUUID())
  await writeFile(join(registry, `${partial}.json`), JSON.stringify({ thread: partial, generation: randomUUID(), usedAt: now }))
  assert.equal((await scratch.preview()).entries.find(row => row.thread === partial)?.eligible, false)
  await assert.rejects(scratch.ensure(partial), /incomplete/)

  let stopAfterIntent = false
  let treeClosed = true, inspectData: (() => void) | undefined
  const artifacts = new ThreadScratch({
    root: join(data, "owned"), kind: "data", registry: join(root, "data-owners"), settings: join(root, "settings.json"), now: () => now,
    owner: () => owner, ancestorsClosed: (id) => treeClosed && !(stopAfterIntent && existsSync(join(root, "data-owners", `${id}.json`)) && JSON.parse(readFileSync(join(root, "data-owners", `${id}.json`), "utf8")).retiring), using: async (_path, id) => { assert.ok(id); return users },
    openFiles: async () => { if (!files) throw new Error("Unavailable"); return files }, privateBytes: async () => { inspectData?.(); return 64 },
  })
  const artifactOwner = ThreadIdSchema.parse(randomUUID())
  owner = { quietAt: now }
  const artifactPath = await artifacts.ensure(artifactOwner)
  await writeFile(join(artifactPath, "proof"), "owned proof")
  const dataEntry = async () => (await artifacts.preview()).entries.find(row => row.thread === artifactOwner)!
  now += 8 * 86_400_000
  assert.equal((await dataEntry()).eligible, false, "idle expiry never removes unfinished Thread data")
  owner = { quietAt: now, finishedAt: now }
  assert.equal((await dataEntry()).kind, "data")
  assert.equal((await dataEntry()).eligible, true)
  inspectData = () => { treeClosed = false }
  assert.equal((await dataEntry()).eligible, false, "an ancestor reopening during measurement invalidates eligibility")
  inspectData = undefined; treeClosed = true
  users = ["the Thread's provider in a different cwd"]
  assert.equal((await dataEntry()).eligible, false)
  users = []; files = [join(artifactPath, "proof")]
  assert.equal((await dataEntry()).eligible, false)
  files = undefined
  assert.equal((await dataEntry()).eligible, false)
  files = []
  await writeFile(join(artifactPath, ".keep"), "")
  assert.equal((await dataEntry()).eligible, false)
  await rm(join(artifactPath, ".keep"))
  await artifacts.configure({ mode: "preview", idleDays: 7, kept: [] })
  await artifacts.run()
  assert.equal(await exists(artifactPath), true, "data preview removes nothing")
  await artifacts.configure({ mode: "remove", idleDays: 7, kept: [] })
  await artifacts.run()
  assert.equal(await exists(artifactPath), true, "old scratch-removal consent does not authorize new Thread-data removal")
  await artifacts.configure({ mode: "remove", dataMode: "remove", idleDays: 7, kept: [] })
  const resumedArtifacts = new ThreadScratch({
    root: join(data, "owned"), kind: "data", registry: join(root, "data-owners"), settings: join(root, "settings.json"), now: () => now,
    owner: () => owner, ancestorsClosed: () => treeClosed, using: async () => [], openFiles: async () => [], privateBytes: async () => 64,
  })
  try {
    const report = await resumedArtifacts.run()
    assert.equal(report.entries.find(row => row.thread === artifactOwner)?.removed, true, "restart retires only a registered finished data generation")
    assert.equal(await exists(artifactPath), false)
    assert.equal(await exists(legacyPath), true, "legacy UUID roots remain untouched")
    assert.equal(await exists(join(data, thread, "kept-proof")), true, "legacy data beside scratch stays")
  } finally { resumedArtifacts.close() }

  const intentOwner = ThreadIdSchema.parse(randomUUID())
  const retainedData = await artifacts.ensure(intentOwner)
  owner = { quietAt: now, finishedAt: now }
  stopAfterIntent = true
  const interruptedData = await artifacts.run()
  assert.equal(interruptedData.entries.find(row => row.thread === intentOwner)?.removed, undefined, "restoring an ancestor after durable retirement intent prevents the rename/removal")
  assert.equal(await exists(retainedData), true)
  assert.equal(JSON.parse(await readFile(join(root, "data-owners", `${intentOwner}.json`), "utf8")).retiring, true, "an interrupted retirement stays held for review")
  stopAfterIntent = false

  const store = new ThreadStore(join(root, "frames.sqlite")), git = new Git()
  try {
    const cwd = join(root, "shared-folder"); await mkdir(cwd)
    await mkdir(join(cwd, ".mako"))
    await writeFile(join(cwd, ".mako", "recipe.json"), JSON.stringify({ values: { PORT: "{port}", APP_URL: "{url}", SCRATCH_FIXTURE: "retained", APP_DATA: "{data}" } }))
    const environments = new ThreadEnvironments({ git, store, dataRoot: join(root, "apps"), listening: async () => false, scratch: id => scratch.ensure(id), threadData: artifacts })
    const register = () => {
      const conversationId = randomUUID()
      store.registerJournal({ conversationId, createdAt: now, bindings: [], harness: "codex" }, { kind: "service", name: "migration" })
      return conversationId
    }
    const first = register(), second = register()
    const one = await environments.forLaunch(first, "First", cwd), two = await environments.forLaunch(second, "Second", cwd)
    assert.ok(one?.scratchDir && two?.scratchDir)
    assert.equal(one.dataDir, two.dataDir, "the ordinary folder app data is shared")
    assert.ok(one.threadDataDir && two.threadDataDir)
    assert.notEqual(one.threadDataDir, two.threadDataDir, "Fin artifact roots follow their actual Threads even in a shared checkout")
    assert.notEqual(one.threadDataDir, one.dataDir)
    assert.equal(await exists(one.threadDataDir), true)
    await writeFile(join(one.dataDir, "app.db"), "existing app state")
    assert.equal(one.values?.APP_DATA, one.dataDir, "recipe {data} is still the shared app root")
    const appCommand = await environments.forConversation(first, "First", cwd)
    assert.equal(appCommand?.threadDataDir, undefined, "app commands never acquire the agent's retirable data binding")
    const commandEnv = commandEnvironment(appCommand)
    assert.equal(commandEnv.MAKO_THREAD_DATA_DIR, one.dataDir)
    assert.equal(commandEnv.MAKO_THREAD_DATA_DIR, commandEnv.MAKO_APP_DATA_DIR, "app commands use shared app state for both names")
    assert.equal(commandEnvironment(one).MAKO_THREAD_DATA_DIR, one.dataDir, "even an accidental agent binding is stripped at the app-command boundary")
    assert.equal(environments.launchedWith(first)?.threadDataDir, one.threadDataDir, "looking up an app command never rewrites the agent launch binding")
    const desk = await environments.forFolder(cwd, true)
    assert.equal(desk.environment?.threadDataDir, undefined, "the app's own process keeps its original data binding")
    assert.equal(desk.environment?.dataDir, one.dataDir)
    assert.deepEqual(await environments.fileDataDir({ conversationId: first, cwd }), [one.threadDataDir, one.dataDir], "files resolve new artifacts first and legacy app links second")
    const oldLaunch = new ThreadEnvironments({ git, store, dataRoot: join(root, "apps"), listening: async () => false })
    const old = await oldLaunch.forLaunch(first, "First", cwd)
    assert.equal(old?.threadDataDir, undefined)
    await environments.forLaunch(second, "Second", cwd)
    assert.equal(oldLaunch.launchedWith(first)?.threadDataDir, undefined, "allocating new roots never rewrites an existing legacy launch binding")
    assert.notEqual(one.scratchDir, two.scratchDir, "scratch ownership follows the actual Thread, never the shared app key")
    assert.equal(await exists(one.scratchDir), true)
    assert.equal((await environments.forConversation(first, "First", cwd))?.scratchDir, one.scratchDir)
    const env: NodeJS.ProcessEnv = { MAKO_THREAD_SCRATCH_DIR: "from-elsewhere" }
    applyThreadEnvironment(env, one)
    assert.equal(env.MAKO_THREAD_SCRATCH_DIR, one.scratchDir)
    assert.equal(env.MAKO_THREAD_DATA_DIR, one.threadDataDir)
    assert.equal(env.MAKO_APP_DATA_DIR, one.dataDir)
    assert.ok(threadEnvironmentInstructions(one).includes(".keep"))
    const firstThread = ThreadIdSchema.parse(one.thread), firstNote = join(registry, `${firstThread}.json`)
    const generation = JSON.parse(await readFile(firstNote, "utf8")).generation
    await rm(one.scratchDir, { recursive: true })
    const relaunched = await environments.forLaunch(first, "First", cwd)
    assert.ok(relaunched?.scratchDir)
    assert.equal(relaunched.port, one.port); assert.equal(relaunched.dataDir, one.dataDir)
    assert.equal(relaunched.scratchDir, one.scratchDir)
    assert.notEqual(JSON.parse(await readFile(firstNote, "utf8")).generation, generation, "a removed complete acquisition gets a new generation")
    const checkFallback = async () => {
      const fallback = await environments.forLaunch(first, "First", cwd)
      assert.ok(fallback)
      assert.equal(fallback.scratchDir, undefined, "a refusal must not advertise a stale previous scratch binding")
      assert.equal(environments.launchedWith(first)?.scratchDir, undefined)
      const values: NodeJS.ProcessEnv = {}
      applyThreadEnvironment(values, fallback)
      assert.equal(values.MAKO_THREAD_PORT, String(one.port)); assert.equal(values.MAKO_THREAD_PORTS, String(one.ports))
      assert.equal(values.MAKO_THREAD_URL, `http://${one.host}:${one.port}`); assert.equal(values.MAKO_THREAD_DATA_DIR, one.threadDataDir); assert.equal(values.MAKO_APP_DATA_DIR, one.dataDir)
      assert.equal(values.PORT, String(one.port)); assert.equal(values.APP_URL, values.MAKO_THREAD_URL)
      assert.equal(values.SCRATCH_FIXTURE, "retained", "scratch refusal cannot drop recipe values")
    }
    const lock = join(registry, `${firstThread}.lock`)
    await mkdir(lock); await checkFallback(); assert.equal(await exists(lock), true); await rm(lock, { recursive: true })
    const completed = await readFile(firstNote, "utf8")
    await writeFile(firstNote, JSON.stringify({ ...JSON.parse(completed), retiring: true }))
    await checkFallback(); await writeFile(firstNote, completed)
    await rm(firstNote); await checkFallback()
    assert.equal(await exists(firstNote), false, "launch fallback does not adopt an unregistered directory")
    await writeFile(firstNote, JSON.stringify({ thread: firstThread, generation: randomUUID(), usedAt: now }))
    await checkFallback(); await writeFile(firstNote, completed)
    const dataLock = join(root, "data-owners", `${firstThread}.lock`)
    await mkdir(dataLock)
    try {
      const fallback = await environments.forLaunch(first, "First", cwd)
      assert.equal(fallback?.threadDataDir, one.threadDataDir, "registration refusal never retargets artifacts into shared app state")
      assert.equal(await readFile(join(one.dataDir, "app.db"), "utf8"), "existing app state")
    } finally { await rm(dataLock, { recursive: true }) }
    // The actual Workspaces composition uses the host store's Fin edge, not a settled personal turn as authority.
    const personal = register(), personalThread = store.journalPlacement(personal)!.thread
    const jobs = new HostJobs()
    const completedAt = Date.now() + 60_000
    const archives = new ThreadArchives(join(root, "ancestor-archives.sqlite"))
    const composed = openWorkspaces({
      git, store, dataRoot: join(root, "host"), readOnly: false, jobs, emit: () => {},
      watch: async () => ({ unsubscribe: async () => {} }),
      inUse: async () => [], retirementUsers: async () => [],
      scratchOwner: () => ({ quietAt: completedAt, finishedAt: completedAt }),
      archived: id => archives.snapshot().keys.includes(threadArchiveKey({ kind: "live", id })),
      working: async () => [], workingFolders: async () => [],
      conversations: { holding: async () => [], leave: async () => [] }, cleanup: () => undefined,
    })
    try {
      const managed = composed.threadData!
      const path = await managed.ensure(personalThread)
      assert.equal(path, join(root, "thread-data", "owned", personalThread, "data"))
      assert.equal((await managed.preview()).entries.find(row => row.thread === personalThread)?.reason, "The Thread is active, elsewhere, or its state is unknown.", "a settled personal Thread is never a finished Fin")
      store.keepEdge({
        child: personalThread, parent: firstThread, parentSession: SessionIdSchema.parse(store.journalPlacement(first)!.session),
        name: "fixture-fin", role: "worker", origin: "started", asked: { brief: { objective: "Fixture only" } },
        op: randomUUID(), startedBy: { kind: "service", name: "migration" }, createdAt: Date.now(),
      })
      const finEntry = async () => (await managed.preview()).entries.find(row => row.thread === personalThread)!
      assert.equal((await finEntry()).eligible, false, "a finished Fin's data is held while its top Apex is open")
      const archiveApex = (archived: boolean) => archives.set({ id: randomUUID(), target: { kind: "live", id: first }, archived }, [threadArchiveKey({ kind: "live", id: first })])
      archiveApex(true)
      assert.equal((await finEntry()).eligible, true, "the actual archive receipt closes the top Apex and releases the ancestor hold")
      archiveApex(false)
      assert.equal((await finEntry()).eligible, false, "restoring the Apex reinstates the hold")
      archiveApex(true)
      const leadConversation = register(), leadThread = store.journalPlacement(leadConversation)!.thread
      const leadEdge = store.keepEdge({
        child: leadThread, parent: firstThread, parentSession: SessionIdSchema.parse(store.thread(firstThread)!.sessions[0]),
        name: "fixture-lead", role: "lead", origin: "started", asked: { brief: { objective: "Fixture only" } },
        op: randomUUID(), startedBy: { kind: "service", name: "migration" }, createdAt: Date.now(),
      })
      const nestedConversation = register(), nestedThread = store.journalPlacement(nestedConversation)!.thread
      store.keepEdge({
        child: nestedThread, parent: leadThread, parentSession: SessionIdSchema.parse(store.thread(leadThread)!.sessions[0]),
        name: "fixture-nested-fin", role: "worker", origin: "started", asked: { brief: { objective: "Fixture only" } },
        op: randomUUID(), startedBy: { kind: "service", name: "migration" }, createdAt: Date.now(),
      })
      await managed.ensure(nestedThread)
      const nestedEntry = async () => (await managed.preview()).entries.find(row => row.thread === nestedThread)!
      assert.equal((await nestedEntry()).eligible, false, "an open intermediate Apex holds data even when the top Apex is archived")
      store.keepEdge({ ...leadEdge, closedAt: Date.now() })
      assert.equal((await nestedEntry()).eligible, true, "a closed intermediate edge and archived top Apex release the tree")
      store.reopenEdge(leadThread, Date.now() + 1)
      assert.equal((await nestedEntry()).eligible, false, "reopening an intermediate edge reinstates its hold")
      archives.set({ id: randomUUID(), target: { kind: "live", id: leadConversation }, archived: true }, [threadArchiveKey({ kind: "live", id: leadConversation })])
      assert.equal((await nestedEntry()).eligible, true, "archiving the intermediate Apex also closes it")
      archiveApex(false)
      assert.equal((await nestedEntry()).eligible, false, "an archived intermediate never hides the open top Apex")
      archiveApex(true)
      assert.equal((await managed.settings()).dataMode, "preview")
      await managed.run()
      assert.equal(await exists(path), true, "the composed default cannot remove Fin data")
    } finally { jobs.stop(); await composed.close(); archives.close() }
    artifacts.close()
    applyThreadEnvironment(env)
    assert.equal(env.MAKO_APP_DATA_DIR, undefined, "nested hosts clear the former app binding")
    assert.equal(env.MAKO_THREAD_SCRATCH_DIR, undefined, "nested hosts do not inherit another Thread's scratch")
  } finally { store.close(); await git.close() }

  scratch.close()
  await assert.rejects(scratch.ensure(thread), /stopping/)
  console.log("Thread scratch: preview/opt-in, ended and idle, keep, active/open/unknown, changing activity, generation replacement, symlink and durable-data guards passed")
} finally { scratch.close(); await rm(root, { recursive: true, force: true }) }
