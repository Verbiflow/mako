import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { RecipeAuthority, RecipeChanges, RecipeProof, RecipeVersionRecord } from "@mako/protocol/recipes"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { AppKeySchema, type ThreadEnvironment } from "@mako/host/contracts/thread-environments"
import { environmentTools } from "@mako/host/workspaces/environment-tools"
import { portListening } from "@mako/host/workspaces/thread-environment"
import { ThreadProcesses } from "@mako/host/workspaces/thread-processes"
import { TraceRefresh } from "@mako/host/workspaces/app-probe"
import { RecipeAccounts, RecipeSchema, placedProofs, publishedVersion, readVersion, recipePath, recipeVersions, saveDraft, syncedWith, versionHistory, type RecipeWhere } from "@mako/host/workspaces/thread-recipe"

/**
 * A project's recipe kept by the account: a laptop and a cloud machine, each with its own store,
 * through one authority. The laptop's history becomes the project's; the machine reads the same version by the same
 * number; the machine proves the published version and the laptop's history shows it proved in both places; two
 * drafts made from one version are numbered apart, and of the two, the first to publish wins while the other is told
 * what was published; an authority that can't be reached keeps reads going and refuses writes; and a store whose own
 * history isn't the account's sets it aside rather than stitching it in.
 */

/** An authority in memory, by the rules `@mako/protocol/recipes` states: numbered once, a publish compared with what's published, one adopt. */
class MemoryAuthority implements RecipeAuthority {
  readonly id = "https://gateway.test/v1/recipes?repository=https://github.com/acme/app"
  versions = new Map<number, { record: RecipeVersionRecord; change: number }>()
  saves = new Map<string, number>()
  change = 0
  published: number | undefined
  down = false
  calls = 0
  #reach(): void {
    this.calls += 1
    if (this.down) throw Object.assign(new Error("fetch failed"), { status: undefined })
  }
  #put(record: RecipeVersionRecord): void {
    this.change += 1
    this.versions.set(record.version, { record: structuredClone(record), change: this.change })
  }
  async changes(after: number): Promise<RecipeChanges> {
    this.#reach()
    const versions = [...this.versions.values()].filter((entry) => entry.change > after).sort((a, b) => a.change - b.change).map((entry) => structuredClone(entry.record))
    return { change: Math.max(after, this.change), published: this.published ?? null, versions, more: false }
  }
  async save(save: Parameters<RecipeAuthority["save"]>[0]): Promise<RecipeVersionRecord> {
    this.#reach()
    const made = this.saves.get(save.id)
    if (made) return structuredClone(this.versions.get(made)!.record)
    const version = Math.max(0, ...this.versions.keys()) + 1
    const record: RecipeVersionRecord = { version, state: "draft", savedAt: save.savedAt, recipe: save.recipe }
    if (save.parent !== undefined) record.parent = save.parent
    if (save.app) record.app = save.app
    if (save.by) record.by = save.by
    if (save.reason) record.reason = save.reason
    this.#put(record)
    this.saves.set(save.id, version)
    return structuredClone(record)
  }
  async publish(publish: Parameters<RecipeAuthority["publish"]>[0]) {
    this.#reach()
    const record = this.versions.get(publish.version)!.record
    if (record.parent !== this.published) {
      return { ok: false as const, published: this.published === undefined ? null : structuredClone(this.versions.get(this.published)!.record), reason: `Version ${this.published} was published after this draft was made from ${record.parent === undefined ? "nothing" : `version ${record.parent}`}.` }
    }
    const done = { ...withProof(record, publish.proof), state: "published" as const, publishedAt: publish.publishedAt }
    this.#put(done)
    this.published = done.version
    return { ok: true as const, record: structuredClone(done) }
  }
  async prove(prove: Parameters<RecipeAuthority["prove"]>[0]): Promise<RecipeVersionRecord> {
    this.#reach()
    const proved = withProof(this.versions.get(prove.version)!.record, prove.proof)
    this.#put(proved)
    return structuredClone(proved)
  }
  async adopt(adopt: Parameters<RecipeAuthority["adopt"]>[0]): Promise<{ adopted: boolean }> {
    this.#reach()
    if (this.change > 0) return { adopted: false }
    for (const record of adopt.versions) this.#put(record)
    this.published = adopt.published ?? undefined
    return { adopted: true }
  }
}

function withProof(record: RecipeVersionRecord, proof: RecipeProof): RecipeVersionRecord {
  const proofs = record.proofs ?? (record.proof ? { [record.proof.place ?? "local"]: record.proof } : {})
  return { ...record, proof, proofs: { ...proofs, [proof.place ?? "local"]: proof } }
}

const MAC: RecipeWhere = { place: "local", platform: "mac" }
const CLOUD: RecipeWhere = { place: "cloud", platform: "linux" }
const git = new Git()
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-recipe-authority-")))
const project = join(root, "app")
mkdirSync(project)
writeFileSync(join(project, "server.mjs"), `
import { createServer } from "node:http"
createServer((_, response) => response.end("ok")).listen(Number(process.env.PORT), "127.0.0.1")
process.on("SIGTERM", () => process.exit(0))
`)
const processes = new ThreadProcesses({ root: join(root, "records"), listening: portListening })
const traces = new TraceRefresh()
async function freeBlock(from: number): Promise<number> {
  for (let base = from; base < from + 2_000; base += 10) {
    const busy = await Promise.all(Array.from({ length: 10 }, (_, index) => portListening(base + index)))
    if (!busy.some(Boolean)) return base
  }
  throw new Error("no free ports for the test")
}
const thread = async (name: string, from: number): Promise<ThreadEnvironment> => {
  const id = ThreadIdSchema.parse(randomUUID())
  const dataDir = join(root, "data", name)
  mkdirSync(dataDir, { recursive: true })
  return { thread: id, app: AppKeySchema.parse(id), host: `${name}.thread.localhost`, port: await freeBlock(from), ports: 10, dataDir }
}
const authority = new MemoryAuthority()
const hostIn = (environment: ThreadEnvironment, where: RecipeWhere, recipesRoot: string, accounts: RecipeAccounts) => environmentTools({
  git,
  cwd: () => project,
  environment: async () => environment,
  launchedWith: () => undefined,
  folder: async () => ({ app: environment.app, checkout: project, project: "app", root: project, environment }),
  processes,
  traces,
  recipesRoot,
  where,
  recipes: accounts,
  settleMs: 10_000,
  pressure: async () => "normal",
})
const recipe = (greeting: string) => RecipeSchema.parse({ values: { PORT: "{port}", GREETING: greeting }, processes: { web: { command: "node server.mjs", port: "{port}" } } })
const laptopRoot = join(root, "laptop-recipes")
const machineRoot = join(root, "machine-recipes")
const mac = await thread("mac", 45_000)
const machine = await thread("machine", mac.port + 10)
const laptopFile = await recipePath(git, laptopRoot, project)
const machineFile = await recipePath(git, machineRoot, project)

try {
  // Before the account kept it: the laptop's own history, published alone (no account to reach).
  const alone = hostIn(mac, MAC, laptopRoot, new RecipeAccounts(async () => undefined))
  await alone.save("first", recipe("one"), "The app")
  assert.match(await alone.publish("first"), /Published version 1/)
  await alone.stop("first")
  assert.equal(await syncedWith(laptopFile), undefined, "kept on this computer alone")

  // Signed in, the account takes the laptop's history as the project's, numbers and all.
  const laptopAccounts = new RecipeAccounts(async () => authority, { freshMs: 0 })
  const laptop = hostIn(mac, MAC, laptopRoot, laptopAccounts)
  await laptop.status("on-mac")
  assert.equal((await syncedWith(laptopFile))?.authority, authority.id)
  assert.deepEqual([[...authority.versions.keys()], authority.published], [[1], 1], "the account keeps version 1 as published")

  // A machine with an empty store reads the project's recipe from the account, the same version by the same number.
  const machineAccounts = new RecipeAccounts(async () => authority, { freshMs: 0 })
  const cloud = hostIn(machine, CLOUD, machineRoot, machineAccounts)
  assert.match(await cloud.status("in-cloud"), /1, published/)
  assert.equal(await publishedVersion(machineFile), 1)

  // The machine proves the published version where it hadn't passed: nothing is published, the proof reaches the laptop.
  const proved = await cloud.publish("in-cloud")
  assert.match(proved, /Version 1, the published one, passed its proof on a cloud machine/, proved)
  await cloud.stop("in-cloud")
  assert.match(await cloud.publish("in-cloud"), /passed its proof on a cloud machine already/)
  await laptop.status("on-mac")
  const version1 = await readVersion(laptopFile, 1)
  assert.ok(version1)
  assert.deepEqual(Object.keys(placedProofs(version1)).sort(), ["cloud", "local"], "the laptop's history shows it proved in both places")
  const history = await versionHistory(laptopFile, mac.app, 5)
  assert.equal(history.entries[0]?.places?.cloud?.passed, true)

  // Two drafts from version 1, one on each: numbered apart by the account, never both 2.
  assert.match(await laptop.save("on-mac", recipe("from the Mac"), "Mac's change"), /\b2\b/)
  assert.match(await cloud.save("in-cloud", recipe("from the machine"), "Machine's change"), /\b3\b/)
  assert.deepEqual([...authority.versions.keys()], [1, 2, 3])
  // The machine publishes first; the laptop's, made from the same version, is refused and told what was published.
  assert.match(await cloud.publish("in-cloud"), /Published version 3/)
  await cloud.stop("in-cloud")
  const refused = await laptop.publish("on-mac")
  assert.match(refused, /Version 3 was published after this draft was made from version 1/, refused)
  assert.equal(await publishedVersion(laptopFile), 3, "the laptop's store takes what was published")
  assert.equal(authority.published, 3)
  assert.match(await laptop.status("on-mac"), /1: published[^\n]*proved on this computer, proved on a cloud machine/, "app_status says where each was proved")
  await laptop.stop("on-mac")

  // The account out of reach: reads go on from what was taken; a save is refused, so nothing is numbered apart.
  authority.down = true
  assert.match(await laptop.status("on-mac"), /2, this Thread.s draft, made from version 1/, "this Thread still runs its refused draft, read from what was taken")
  await assert.rejects(laptop.save("on-mac", recipe("offline"), "While out of reach"), /couldn't reach your account, which keeps this project's recipe versions/)
  await assert.rejects(saveDraft(git, laptopRoot, project, recipe("direct"), mac, {}, Date.now(), await laptopAccounts.forWrite(laptopFile, project).catch(() => authority)), /fetch failed/)
  authority.down = false

  // A store with a history of its own that isn't the account's: set aside beside it, never stitched in.
  const otherRoot = join(root, "other-recipes")
  const otherAlone = hostIn(mac, MAC, otherRoot, new RecipeAccounts(async () => undefined))
  await otherAlone.save("other", recipe("another history"), "Another laptop's")
  await otherAlone.publish("other")
  await otherAlone.stop("other")
  const otherFile = await recipePath(git, otherRoot, project)
  const other = hostIn(mac, MAC, otherRoot, new RecipeAccounts(async () => authority, { freshMs: 0 }))
  await other.status("other")
  assert.equal(await publishedVersion(otherFile), 3, "the account's history is the project's")
  const aside = readdirSync(dirname(recipeVersions(otherFile))).filter((name) => name.includes(".set-aside-"))
  assert.equal(aside.length, 1, "its own set aside, kept")
  assert.ok(existsSync(join(dirname(recipeVersions(otherFile)), aside[0]!, "1.json")))

  console.log(`PASS: a project's recipe kept by the account: one numbering for a laptop and a machine, a machine's proof in the laptop's history, a publish over another's refused with what was published, writes refused and reads kept while out of reach, another history set aside (${authority.calls} calls)`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
