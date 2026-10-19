import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { DECODE_ASIDE_BYTES, DecodeAside, pageOf, SAVED_HISTORY_READERS, SessionCatalog, VIEWER_PAGE, ViewCache, type AsideJob, type AsideOutcome, type NativeFile, type Thread, type ThreadPageOptions } from "@mako/sessions"
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
    const thread = (title: string): Thread => ({ ref: { harness: "claude", nativeId: title, path: `/s/${title}`, title }, entries: [{ type: "user", id: "u1", text: "x".repeat(400) }] })
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

    const large = (title: string): Thread => ({
      ref: { harness: "claude", nativeId: title, path: `/s/${title}`, title },
      entries: Array.from({ length: 120 }, (_, index) => index % 2
        ? { type: "tool", id: `t${index}`, name: "Bash", status: "completed", input: `{"command":"seq ${index}"}`, output: `${index}\n`.repeat(400) }
        : { type: "user", id: `u${index}`, text: `${index} `.repeat(300) }),
    })
    const weighing = new ViewCache(null, () => build)
    await weighing.write("/s/x", stamp, large("x"), 5)
    const largeBytes = (await weighing.stats()).bytes
    weighing.close()
    const memoryBudget = Math.floor(largeBytes * 2.5)
    const memory = new ViewCache(null, () => build, memoryBudget)
    await servesTheDecode(memory, { ...thread("small"), ref: { ...thread("small").ref, bytes: 10 } }, "a small view in memory")
    await servesTheDecode(memory, { ...large("big"), ref: { ...large("big").ref, bytes: 10 } }, "a large view in memory")
    const held = (await memory.list()).map((view) => [view.path, view.total])
    assert.deepEqual(held.sort(), [["/s/big", 120], ["/s/small", 1]], "both are held, small and large")
    for (const name of ["e", "f"]) await memory.write(`/s/${name}`, stamp, large(name), 5)
    await memory.settled()
    assert.ok((await memory.stats()).bytes <= memoryBudget, "the budget holds in memory")
    assert.equal(await memory.read("/s/small", { bytes: 10, mtimeMs: 1 }), null, "and evicts the view used longest ago")
    memory.close()
    console.log("PASS: views are stamped by record and build, stale reads are explicit, the budget evicts the oldest, on disk and in memory")
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/**
 * A view of a record that grew is continued from its last turn, not decoded
 * again, and holds what a whole decode of the grown record does. Each
 * fixture of the readers that continue decodes, cut at its middle line.
 */
async function viewsContinue(): Promise<void> {
  const stores = new NativeStores(false)
  let continued = 0
  for (const harness of ["claude", "codex", "grok"] as const) {
    for (const name of await readdir(join(FIXTURE_ROOT, harness, "pairs"))) {
      const pair = join(FIXTURE_ROOT, harness, "pairs", name)
      const parsed = PairSchema.safeParse(JSON.parse(await readFile(join(pair, "pair.json"), "utf8").catch(() => "{}")))
      const store = parsed.data?.stores.find((candidate) => candidate.reader === harness && !candidate.path.includes("#"))
      if (!store) continue
      const home = await mkdtemp(join(tmpdir(), `mako-views-continue-${harness}-`))
      try {
        await cp(join(pair, "home"), home, { recursive: true })
        const path = join(home, store.path)
        const whole = await readFile(path)
        const ends = [...whole.entries()].flatMap(([at, byte]) => byte === 0x0a ? [at + 1] : [])
        const cut = ends[Math.floor(ends.length / 2)]
        if (cut === undefined || cut === whole.length) continue
        await writeFile(path, whole.subarray(0, cut))
        const first = catalogAt(home, stores, "build-continue")
        const before = await first.open(path, false)
        await first.stop()
        if (!before?.resume) continue
        const info = await stat(path)
        const views = new ViewCache(join(home, ".mako", "views"), () => "build-continue")
        await views.write(path, { bytes: info.size, mtimeMs: info.mtimeMs }, before, 500)
        await views.settled()
        await appendFile(path, whole.subarray(cut))

        const second = catalogAt(home, stores, "build-continue")
        const grown = await second.open(path, false)
        const page = await second.page(path, undefined, 3, VIEWER_PAGE)
        await second.stop()
        const [meta] = await views.list()
        assert.equal(meta?.continued?.count, 1, `${harness}/${name}: the grown record's view was continued`)
        const fresh = catalogAt(home, stores, "build-fresh")
        const expected = await fresh.open(path, false)
        await fresh.stop()
        assert.deepEqual(plain(grown?.entries), plain(expected?.entries), `${harness}/${name}: a continued view holds what a whole decode does`)
        assert.deepEqual(plain(grown?.unread), plain(expected?.unread), `${harness}/${name}: and counts the same unread records`)
        assert.equal(page?.total, expected?.entries.length, `${harness}/${name}: and pages them all`)
        continued++
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  }
  assert.ok(continued >= 30, `views continued: ${continued}`)
  console.log(`PASS: ${continued} views of grown records continued from their last turn, each as a whole decode reads it`)
}

/**
 * A follow takes over from the decode it was shown at that decode's last
 * turn: what a window holds of the view, changed as the follow's updates
 * say, is what a whole decode of the grown record holds, and no update
 * resends the session. Each fixture of the readers that continue decodes,
 * cut at its middle line, which is mostly inside a turn.
 */
async function followsTakeOver(): Promise<void> {
  const stores = new NativeStores(false)
  const cases: { harness: string; pair: string; path: string }[] = []
  for (const harness of ["claude", "codex", "grok"] as const) {
    for (const name of await readdir(join(FIXTURE_ROOT, harness, "pairs"))) {
      const pair = join(FIXTURE_ROOT, harness, "pairs", name)
      const parsed = PairSchema.safeParse(JSON.parse(await readFile(join(pair, "pair.json"), "utf8").catch(() => "{}")))
      const store = parsed.data?.stores.find((candidate) => candidate.reader === harness && !candidate.path.includes("#"))
      if (store) cases.push({ harness, pair, path: store.path })
    }
  }
  const results = await Promise.all(cases.map(async ({ harness, pair, path: relative }) => {
    const label = `${harness}/${basename(pair)}`
    const home = await mkdtemp(join(tmpdir(), "mako-follow-takeover-"))
    try {
      await cp(join(pair, "home"), home, { recursive: true })
      const path = join(home, relative)
      const whole = await readFile(path)
      const ends = [...whole.entries()].flatMap(([at, byte]) => byte === 0x0a ? [at + 1] : [])
      const cut = ends[Math.floor(ends.length / 2)]
      if (cut === undefined || cut === whole.length) return null
      await writeFile(path, whole.subarray(0, cut))
      const catalog = catalogAt(home, stores, "build-follow")
      const served = await catalog.open(path)
      if (!served?.resume) {
        await catalog.stop()
        return null
      }
      let shown = served.entries
      let resent = 0
      let sent = 0
      const updates: string[] = []
      const stop = catalog.follow(path, served.checkpoint ?? 0, (entries, replaced, replaceFrom) => {
        if (replaced && (replaceFrom ?? 0) === 0 && served.resume!.entry > 0) resent++
        sent += entries.length
        updates.push(`${replaced ? `replace from ${replaceFrom ?? 0}` : "append"}: ${entries.map((entry) => entry.type).join(", ")}`)
        shown = replaced ? [...shown.slice(0, replaceFrom ?? 0), ...entries] : [...shown, ...entries]
      })
      await appendFile(path, whole.subarray(cut))
      const fresh = catalogAt(home, stores, "build-fresh")
      const expected = plain((await fresh.open(path, false))?.entries ?? [])
      await fresh.stop()
      for (let wait = 0; wait < 100 && !isDeepStrictEqual(plain(shown), expected); wait++) await new Promise((resolve) => setTimeout(resolve, 50))
      stop()
      await catalog.stop()
      assert.deepEqual(plain(shown), expected, `${label}: a followed view holds what a whole decode of the grown record does`)
      assert.equal(resent, 0, `${label}: and no update resent the session`)
      const before = plain(served.entries)
      let same = 0
      while (same < before.length && isDeepStrictEqual(before[same], expected[same])) same++
      assert.equal(sent, expected.length - same, `${label}: and the follow sent the entries from the first that changed (${same} of ${expected.length} held), no more: ${updates.join("; ")}`)
      return label
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }))
  const followed = results.filter(Boolean).length
  assert.ok(followed >= 30, `follows taken over: ${followed}`)
  console.log(`PASS: ${followed} follows took over from the view they were shown at its last turn, each as a whole decode reads the grown record`)
}

/**
 * A record past `DECODE_ASIDE_BYTES` decodes in a child process, which
 * writes its view: the catalog pages and opens it as a decode in its own
 * process reads it. The child makes its readers under `HOME`, as this
 * process does.
 */
async function decodesAside(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "mako-decode-aside-"))
  const was = process.env["HOME"]
  process.env["HOME"] = home
  try {
    const session = randomUUID()
    const folder = join(home, ".claude", "projects", "-tmp-aside")
    await mkdir(folder, { recursive: true })
    const path = join(folder, `${session}.jsonl`)
    const base = { sessionId: session, cwd: "/tmp/aside", version: "2.1.283", userType: "external", isSidechain: false }
    const lines: string[] = []
    let parent: string | null = null
    for (let turn = 0; turn < 2400; turn++) {
      const prompt = randomUUID()
      const reply = randomUUID()
      const at = new Date(Date.UTC(2026, 9, 1) + turn * 60_000).toISOString()
      lines.push(JSON.stringify({ ...base, parentUuid: parent, type: "user", uuid: prompt, timestamp: at, message: { role: "user", content: `Prompt ${turn}` } }))
      lines.push(JSON.stringify({ ...base, parentUuid: prompt, type: "assistant", uuid: reply, timestamp: at, message: { id: `msg_${turn}`, type: "message", role: "assistant", model: "claude-fable-5-1", content: [{ type: "text", text: `Reply ${turn} ${"x".repeat(14_000)}` }], stop_reason: "end_turn" } }))
      parent = reply
    }
    await writeFile(path, `${lines.join("\n")}\n`)
    assert.ok((await stat(path)).size >= DECODE_ASIDE_BYTES, "the record decodes aside")
    const stores = new NativeStores(false)
    class Counted extends DecodeAside {
      runs = 0
      decoded = 0
      override async decode(job: AsideJob): Promise<AsideOutcome> {
        this.runs++
        const outcome = await super.decode(job)
        if (outcome.ok) this.decoded++
        return outcome
      }
    }
    const aside = new Counted()
    const catalog = new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(stores)), { viewsPath: join(home, ".mako", "views"), decodeAside: aside, translator: "build-aside" })
    const here = new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(stores)), { translator: "build-here" })
    try {
      const page = await catalog.page(path, undefined, 50, VIEWER_PAGE)
      assert.deepEqual([aside.runs, aside.decoded], [1, 1], "the decode ran aside")
      const whole = await here.open(path, false)
      assert.ok(whole && whole.entries.length >= 4800)
      assert.equal(page?.total, whole.entries.length, "its view pages every entry")
      assert.deepEqual(plain(page?.entries), plain(pageOf(whole.entries, whole.entries.length, 50, VIEWER_PAGE).entries), "as a decode here slices them")
      assert.deepEqual(plain((await catalog.open(path, false))?.entries), plain(whole.entries), "and opens as a decode here reads it")
      assert.equal(aside.runs, 1, "from the view the decode kept")

      // A follow continues the record as it grows. Where its next update
      // would read the record whole, a file replacing it, it reloads when its
      // listener can: the next page decodes aside. A listener that can't is
      // sent the whole read, as before.
      const until = async (done: () => boolean, what: string) => {
        for (let waited = 0; !done(); waited += 50) {
          assert.ok(waited < 15_000, what)
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      const updates: { replaced: boolean; text: string; count: number }[] = []
      let reloads = 0
      const onEntries = (entries: unknown[], replaced: boolean) => updates.push({ replaced, text: JSON.stringify(entries), count: entries.length })
      const stopReloading = catalog.follow(path, page?.checkpoint ?? page?.ref.bytes ?? 0, onEntries, () => reloads++)
      const prompt = randomUUID()
      const at = new Date(Date.UTC(2026, 9, 3)).toISOString()
      await appendFile(path, `${JSON.stringify({ ...base, parentUuid: parent, type: "user", uuid: prompt, timestamp: at, message: { role: "user", content: "Prompt appended" } })}\n`)
      await until(() => updates.some((update) => update.text.includes("Prompt appended")), "the follow delivers what was appended")
      assert.equal(reloads, 0, "an append continues the follow")
      const delivered = updates.length
      const replace = async (reply: string) => {
        const last = JSON.parse(lines.at(-1)!)
        last.message.content[0].text = reply
        await writeFile(`${path}.next`, `${[...lines.slice(0, -1), JSON.stringify(last)].join("\n")}\n`)
        await rename(`${path}.next`, path)
      }
      await replace("Reply replaced")
      await until(() => reloads === 1, "a replaced record reloads the follow")
      await new Promise((resolve) => setTimeout(resolve, 1200))
      assert.equal(updates.length, delivered, "and delivers nothing read whole")
      assert.equal(reloads, 1, "once: the reload ended the follow")
      stopReloading()
      const reloaded = await catalog.page(path, undefined, 50, VIEWER_PAGE)
      assert.deepEqual([aside.runs, reloaded?.total], [2, lines.length], "the page after it decodes the new record aside")

      const stopWhole = catalog.follow(path, reloaded?.checkpoint ?? reloaded?.ref.bytes ?? 0, onEntries)
      await replace("Reply replaced again")
      await until(() => updates.length > delivered, "a listener without a reload is sent the whole read")
      assert.deepEqual(updates.slice(delivered).map((update) => [update.replaced, update.count]), [[true, lines.length]], "the whole new record")
      assert.ok(updates.at(-1)?.text.includes("Reply replaced again"))
      stopWhole()
      await writeFile(path, `${lines.join("\n")}\n`)
    } finally {
      await catalog.stop()
      await here.stop()
    }

    // The archive keeps no new copies: the record store holds the session, large or small.
    const small = join(folder, `${randomUUID()}.jsonl`)
    await writeFile(small, `${lines.slice(0, 2).join("\n")}\n`)
    const archivePath = join(home, ".mako", "archive")
    const archiving = new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(stores)), {
      viewsPath: join(home, ".mako", "views"), decodeAside: new DecodeAside(), translator: "build-aside", archivePath,
      recordsPath: join(home, ".mako", "records"), recordsHome: home, readBack: { readers: SAVED_HISTORY_READERS, stores },
    })
    await archiving.scan()
    await archiving.stop()
    assert.equal(existsSync(join(archivePath, "archive.sqlite")), false, "the archive copies neither a small session nor a large one")
    console.log("PASS: a large record decodes in a child process, whose view serves as a decode in this one would; its follow reloads where it would read it whole; and the archive copies nothing")
  } finally {
    process.env["HOME"] = was
    await rm(home, { recursive: true, force: true })
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

/** A value as JSON carries it, so undefined fields don't count; `deepEqual` ignores key order. */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value) ?? "null")

/** Cuts a reader asks for: the viewer's page, a full page, a narrow one, and ones that trim to a budget. */
const CUTS: ThreadPageOptions[] = [
  VIEWER_PAGE,
  {},
  { toolOutputChars: 64 },
  { maxChars: 2_000, toolOutputChars: VIEWER_PAGE.toolOutputChars },
  { maxChars: 300 },
]

/**
 * What a view serves is what the decode holds: read whole from the view, and
 * each page of it equal to the same page sliced from the decode in memory.
 */
async function servesTheDecode(cache: ViewCache, thread: Thread, label: string): Promise<void> {
  const stamp = { path: thread.ref.path, bytes: thread.ref.bytes ?? 0, mtimeMs: 1 }
  await cache.write(thread.ref.path, stamp, thread, 50)
  const view = await cache.view(thread.ref.path, stamp)
  assert.ok(view, `${label}: the view reads back`)
  assert.deepEqual(plain(view.thread()), plain(thread), `${label}: whole as decoded`)
  const total = thread.entries.length
  for (const options of CUTS) {
    for (const end of new Set([total, Math.floor(total / 2), 1])) {
      for (const limit of [1, 3, 200]) {
        if (end < 1) continue
        const page: ReturnType<typeof pageOf> = view.page(end, limit, options)
        const expected = pageOf(thread.entries, end, limit, options)
        assert.equal(page.start, expected.start, `${label}: page ${end}/${limit} ${JSON.stringify(options)} starts where the slice does`)
        assert.deepEqual(plain(page.entries), plain(expected.entries), `${label}: page ${end}/${limit} ${JSON.stringify(options)} holds what the slice does`)
      }
    }
  }
  for (const entry of thread.entries) {
    if (!entry.id) continue
    assert.deepEqual(plain(view.entry(entry.id)), plain(entry), `${label}: entry ${entry.id} by id`)
  }
}

/** A view keeps every field a decode makes: what the schema drops, a cached open would lose. */
async function viewsKeepEveryField(): Promise<void> {
  const stores = new NativeStores(false)
  const viewsHome = await mkdtemp(join(tmpdir(), "mako-view-pages-"))
  const views = new ViewCache(viewsHome, () => "test", 1024 * 1024 * 1024)
  const memory = new ViewCache(null, () => "test", 1024 * 1024 * 1024)
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
          await servesTheDecode(views, thread, `${harness}/${name}`)
          await servesTheDecode(memory, thread, `${harness}/${name} in memory`)
          const stamp = { path: thread.ref.path, bytes: thread.ref.bytes ?? 0, mtimeMs: 1 }
          const [disk, held] = [await views.view(thread.ref.path, stamp), await memory.view(thread.ref.path, stamp)]
          assert.deepEqual([held?.meta.total, held?.meta.chars], [disk?.meta.total, disk?.meta.chars], `${harness}/${name}: a view in memory counts as one on disk`)
          sessions++
        }
        await catalog.stop()
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  }
  views.close()
  memory.close()
  await rm(viewsHome, { recursive: true, force: true })
  assert.ok(sessions >= HARNESSES.length * 5, `fixtures decoded: ${sessions}`)
  console.log(`PASS: views keep every field of ${sessions} fixture sessions across all six harnesses, and page as the decode slices`)
}

/**
 * A reader's `stat` of a session is the stamp its discovery lists, so a view
 * is kept exactly as long as the catalog sees no change in the session.
 * Each fixture home, every reader that stats.
 */
async function statsAsDiscovered(): Promise<void> {
  const stores = new NativeStores(false)
  const stamp = (file: NativeFile | null) => file && { path: file.path, bytes: file.bytes, mtimeMs: file.mtimeMs, revision: file.revision, locked: file.locked }
  let stamped = 0
  const by = new Map<string, number>()
  for (const harness of HARNESSES) {
    for (const name of await readdir(join(FIXTURE_ROOT, harness, "pairs"))) {
      const home = join(FIXTURE_ROOT, harness, "pairs", name, "home")
      const providers = SAVED_HISTORY_READERS.map((reader) => reader(stores, { home, kept: join(home, ".mako", "kept-outputs") }))
      for (const provider of providers) {
        if (!provider.stat) continue
        for (const file of await provider.discover().catch(() => [])) {
          assert.deepEqual(stamp(await provider.stat(file.path)), stamp(file), `${harness}/${name}: ${provider.harness} stats ${file.path} as it lists it`)
          stamped++
          by.set(provider.constructor.name, (by.get(provider.constructor.name) ?? 0) + 1)
        }
        provider.close?.()
      }
    }
  }
  assert.ok(stamped >= 100, `sessions stamped: ${stamped}`)
  console.log(`PASS: ${stamped} fixture sessions stat as their readers list them (${[...by].map(([reader, count]) => `${reader} ${count}`).join(", ")})`)
}

for (const harness of HARNESSES) await readsBackAfterDeletion(harness)
await statsAsDiscovered()
await viewsKeepEveryField()
await viewCache()
await viewsContinue()
await followsTakeOver()
await decodesAside()
await stalePages()
