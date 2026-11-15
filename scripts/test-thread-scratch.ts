import "./lib/scratch-git.mjs"
import { Git } from "@mako/git"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadEnvironments, applyThreadEnvironment, threadEnvironmentInstructions } from "@mako/host/workspaces/thread-environment"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { mock } from "node:test"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { ThreadScratch } from "@mako/host/workspaces/thread-scratch"

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

  const store = new ThreadStore(join(root, "frames.sqlite")), git = new Git()
  try {
    const cwd = join(root, "shared-folder"); await mkdir(cwd)
    await mkdir(join(cwd, ".mako"))
    await writeFile(join(cwd, ".mako", "recipe.json"), JSON.stringify({ values: { PORT: "{port}", APP_URL: "{url}", SCRATCH_FIXTURE: "retained" } }))
    const environments = new ThreadEnvironments({ git, store, dataRoot: join(root, "apps"), listening: async () => false, scratch: id => scratch.ensure(id) })
    const register = () => {
      const conversationId = randomUUID()
      store.registerJournal({ conversationId, createdAt: now, bindings: [], harness: "codex" }, { kind: "service", name: "migration" })
      return conversationId
    }
    const first = register(), second = register()
    const one = await environments.forLaunch(first, "First", cwd), two = await environments.forLaunch(second, "Second", cwd)
    assert.ok(one?.scratchDir && two?.scratchDir)
    assert.equal(one.dataDir, two.dataDir, "the ordinary folder app data is shared")
    assert.notEqual(one.scratchDir, two.scratchDir, "scratch ownership follows the actual Thread, never the shared app key")
    assert.equal(await exists(one.scratchDir), true)
    assert.equal((await environments.forConversation(first, "First", cwd))?.scratchDir, one.scratchDir)
    const env: NodeJS.ProcessEnv = { MAKO_THREAD_SCRATCH_DIR: "from-elsewhere" }
    applyThreadEnvironment(env, one)
    assert.equal(env.MAKO_THREAD_SCRATCH_DIR, one.scratchDir)
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
      assert.equal(values.MAKO_THREAD_URL, `http://${one.host}:${one.port}`); assert.equal(values.MAKO_THREAD_DATA_DIR, one.dataDir)
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
    applyThreadEnvironment(env)
    assert.equal(env.MAKO_THREAD_SCRATCH_DIR, undefined, "nested hosts do not inherit another Thread's scratch")
  } finally { store.close(); await git.close() }

  scratch.close()
  await assert.rejects(scratch.ensure(thread), /stopping/)
  console.log("Thread scratch: preview/opt-in, ended and idle, keep, active/open/unknown, changing activity, generation replacement, symlink and durable-data guards passed")
} finally { scratch.close(); await rm(root, { recursive: true, force: true }) }
