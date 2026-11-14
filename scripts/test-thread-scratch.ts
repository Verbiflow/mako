import "./lib/scratch-git.mjs"
import { Git } from "@mako/git"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadEnvironments, applyThreadEnvironment, threadEnvironmentInstructions } from "@mako/host/workspaces/thread-environment"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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

  const outside = join(root, "outside")
  await mkdir(outside); await writeFile(join(outside, "proof"), "outside")
  await symlink(outside, join(path, "linked"))
  const report = await scratch.run()
  assert.equal(report.entries[0]?.removed, true)
  assert.equal(await exists(path), false)
  assert.equal(await readFile(join(outside, "proof"), "utf8"), "outside", "nested links never turn into foreign cleanup")
  assert.equal(await readFile(join(dirname(path), "kept-proof"), "utf8"), "not scratch", "the Thread's durable data survives")

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
    applyThreadEnvironment(env)
    assert.equal(env.MAKO_THREAD_SCRATCH_DIR, undefined, "nested hosts do not inherit another Thread's scratch")
  } finally { store.close(); await git.close() }

  scratch.close()
  await assert.rejects(scratch.ensure(thread), /stopping/)
  console.log("Thread scratch: preview/opt-in, ended and idle, keep, active/open/unknown, changing activity, generation replacement, symlink and durable-data guards passed")
} finally { scratch.close(); await rm(root, { recursive: true, force: true }) }
