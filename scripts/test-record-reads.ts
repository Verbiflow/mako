import assert from "node:assert/strict"
import { cp, mkdtemp, readdir, readFile, rm, stat, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { SAVED_HISTORY_READERS, SessionCatalog, ViewCache, type Thread } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { ThreadSchema } from "@mako/sessions/thread-schema"
import { FIXTURE_ROOT } from "./native-decoding.ts"

// What a journal that keeps no copy of its history relies on: the catalog
// holds a session in the record store on request, reads it back from there
// once its harness deleted it, and answers a rebuilt app at once from the
// view the last build decoded.

const PairSchema = z.object({ stores: z.array(z.object({ reader: z.string(), path: z.string() })).min(1) })
const HARNESSES = ["claude", "codex", "cursor", "devin", "grok", "opencode"] as const

function catalogAt(home: string, stores: NativeStores, translator?: string): SessionCatalog {
  const kept = join(home, ".mako", "kept-outputs")
  return new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(stores, { home, kept })), {
    recordsPath: join(home, ".mako", "records"),
    recordsHome: home,
    viewsPath: join(home, ".mako", "views"),
    readBack: { readers: SAVED_HISTORY_READERS, stores },
    translator,
  })
}

/** Entries as a reader shows them; the ref says where it read them. */
function shown(thread: Thread | null): string {
  assert.ok(thread, "the session reads")
  return JSON.stringify(thread.entries)
}

async function readsBackAfterDeletion(harness: (typeof HARNESSES)[number]): Promise<void> {
  const pair = join(FIXTURE_ROOT, harness, "pairs", "cited-lines")
  const { stores: [store] } = PairSchema.parse(JSON.parse(await readFile(join(pair, "pair.json"), "utf8")))
  const home = await mkdtemp(join(tmpdir(), `mako-record-reads-${harness}-`))
  const stores = new NativeStores(false)
  try {
    await cp(join(pair, "home"), home, { recursive: true })
    const path = join(home, store!.path)
    const first = catalogAt(home, stores)
    const original = await first.open(path)
    const expected = shown(original)
    assert.equal(await first.hold(path), true, `${harness}: the record store holds the session`)
    await first.stop()

    const file = path.split("#")[0]!
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${file}${suffix}`, { force: true })

    const second = catalogAt(home, stores)
    const restored = await second.open(path)
    assert.equal(shown(restored), expected, `${harness}: read back from the record store as its harness read it`)
    assert.equal(restored!.ref.path, path, `${harness}: under the path the catalog knew it by`)
    assert.equal(restored!.ref.archived, true, `${harness}: marked as no longer in its harness`)
    assert.equal(await second.hold(path), false, `${harness}: a session read back isn't held again`)
    await second.stop()
    console.log(`PASS: ${harness} reads back from its records once its harness deleted it`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/** A view is this build's, of exactly one stamp; `readAny` serves any build's for a stale first paint. */
async function viewCache(): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), "mako-views-"))
  try {
    let build = "build-1"
    const thread = (title: string): Thread => ({ ref: { harness: "claude", nativeId: title, path: `/s/${title}`, title }, entries: [{ kind: "user", text: "x".repeat(400) }] })
    const stamp = { bytes: 10, mtimeMs: 1_000 }
    const sizing = new ViewCache(join(folder, "sizing"), () => build)
    await sizing.write("/s/a", stamp, thread("a"), 50)
    const size = (await sizing.stats()).bytes
    const budget = Math.floor(size * 3.5)
    const views = new ViewCache(folder, () => build, budget)
    await views.write("/s/a", stamp, thread("a"), 50)
    assert.equal((await views.read("/s/a", stamp))?.ref.title, "a", "a view answers its stamp")
    assert.equal(await views.read("/s/a", { bytes: 11, mtimeMs: 1_000 }), null, "a grown record misses")
    assert.equal(await views.read("/s/a", { ...stamp, revision: "r2" }), null, "a moved revision misses")
    build = "build-2"
    assert.equal(await views.read("/s/a", stamp), null, "another build's view misses")
    assert.equal((await views.readAny("/s/a", stamp))?.translator, "build-1", "but serves a stale first paint")
    assert.equal(await views.readAny("/s/a", { bytes: 11, mtimeMs: 1_000 }), null, "never of another stamp")
    const used = async (name: string, at: number) => {
      const view = (await views.list()).find((summary) => summary.path === `/s/${name}`)
      assert.ok(view, `a view of ${name}`)
      await utimes(view.file, at / 1000, at / 1000)
    }
    await used("a", 1_000_000)
    for (const [index, name] of ["b", "c"].entries()) {
      await views.write(`/s/${name}`, stamp, thread(name), 50)
      await used(name, 2_000_000 + index * 1000)
    }
    assert.ok(await views.readAny("/s/a", stamp))
    await views.write("/s/d", stamp, thread("d"), 50)
    await views.settled()
    const kept = (await views.list()).map((view) => view.path).sort()
    assert.deepEqual(kept, ["/s/a", "/s/c", "/s/d"], "the budget evicts the view used longest ago, and reading one is a use")
    assert.ok((await views.stats()).bytes <= budget)
    await views.remove("/s/d")
    assert.equal(await views.readAny("/s/d", stamp), null)
    console.log("PASS: views are stamped by record and build, stale reads are explicit, the budget evicts the oldest")
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/** The catalog writes a view of a slow decode, and a rebuilt catalog pages it stale until it decodes again. */
async function stalePages(): Promise<void> {
  const pair = join(FIXTURE_ROOT, "claude", "pairs", "cited-lines")
  const { stores: [store] } = PairSchema.parse(JSON.parse(await readFile(join(pair, "pair.json"), "utf8")))
  const home = await mkdtemp(join(tmpdir(), "mako-stale-pages-"))
  const stores = new NativeStores(false)
  try {
    await cp(join(pair, "home"), home, { recursive: true })
    const path = join(home, store!.path)
    const views = new ViewCache(join(home, ".mako", "views"), () => "build-old")
    const info = await stat(path)
    const first = catalogAt(home, stores, "build-new")
    const decoded = await first.open(path)
    await first.stop()
    await views.write(path, { bytes: info.size, mtimeMs: info.mtimeMs }, decoded!, 500)
    await views.settled()

    const second = catalogAt(home, stores, "build-new")
    const stale = await second.page(path, undefined, 100, { stale: true })
    assert.equal(stale?.translator, "build-old", "the old build's view answers a stale page")
    assert.deepEqual(stale?.entries, decoded!.entries.slice(-100), "a view holds what the decode did")
    const fresh = await second.page(path)
    assert.equal(fresh?.translator, "build-new", "a page decodes for this build")
    assert.equal((await second.page(path, undefined, 100, { stale: true }))?.translator, "build-new", "and is warm after")
    await second.stop()
    const unknown = catalogAt(home, stores, "build-new")
    assert.equal(await unknown.page(join(home, "nothing.jsonl"), undefined, 100, { stale: true }), null, "no view, no page")
    await unknown.stop()
    console.log("PASS: a rebuilt catalog pages the last build's view until it decodes again")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/** A view keeps every field a decode makes: what the schema drops, a cached open would lose. */
async function viewsKeepEveryField(): Promise<void> {
  const stores = new NativeStores(false)
  let sessions = 0
  for (const harness of HARNESSES) {
    for (const name of await readdir(join(FIXTURE_ROOT, harness, "pairs"))) {
      const pair = join(FIXTURE_ROOT, harness, "pairs", name)
      const parsed = PairSchema.safeParse(JSON.parse(await readFile(join(pair, "pair.json"), "utf8").catch(() => "{}")))
      if (!parsed.success) continue
      const home = await mkdtemp(join(tmpdir(), `mako-view-fields-${harness}-`))
      try {
        await cp(join(pair, "home"), home, { recursive: true })
        const catalog = catalogAt(home, stores)
        for (const store of parsed.data.stores) {
          const thread = await catalog.open(join(home, store.path))
          if (!thread) continue
          assert.deepEqual(ThreadSchema.parse(JSON.parse(JSON.stringify(thread))), JSON.parse(JSON.stringify(thread)), `${harness}/${name}: a view keeps the decode whole`)
          sessions++
        }
        await catalog.stop()
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  }
  assert.ok(sessions >= HARNESSES.length * 5, `fixtures decoded: ${sessions}`)
  console.log(`PASS: views keep every field of ${sessions} fixture sessions across all six harnesses`)
}

for (const harness of HARNESSES) await readsBackAfterDeletion(harness)
await viewsKeepEveryField()
await viewCache()
await stalePages()
