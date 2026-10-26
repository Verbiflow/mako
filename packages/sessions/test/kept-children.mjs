import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { appendFile, cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { dirname, join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { SessionCatalog } from "../dist/catalog.js"
import { ChildSidecars, toolIdsOf } from "../dist/child-sidecars.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { homePlace, SAVED_HISTORY_READERS } from "../dist/readers.js"
import { RecordStore } from "../dist/record-store.js"

/**
 * The agents a session started, once its harness deletes the session: on
 * every harness's recorded store with a parent and its children (Claude
 * Code's subagents, Codex's spawned agents and a review, Grok's subagent
 * sessions, OpenCode's child sessions, Devin CLI's subagent chains and
 * Devin.app's journaled subagents, a Cursor Task's own store and an SDK
 * agent's plain transcript). The record store holds the children with the
 * parent; the harness deletes both; the rail lists the parent from Mako's
 * records, and its children list and open as they did, at the same paths,
 * with Show original, and a transcript carries each beside its parent; a
 * fresh catalog opens a child by its path alone. A
 * restore writes both back, the harness's own reader lists and reads them,
 * and a restore asked again writes nothing. The person's delete forgets both.
 */

const stores = new NativeStores(false)
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "child-transcripts")
const HARNESSES = ["claude", "codex", "grok", "opencode", "devin", "cursor"]

/** A Codex review of the fixture's parent: its own rollout, its row, and the parent's end of it, as Codex 0.159 writes them. */
async function addCodexReview(home) {
  const sessions = join(home, ".codex", "sessions", "2026", "10", "05")
  const parent = "01a10e20-ea2e-75a1-9728-1d897d685d09"
  const spawned = "01a10e20-fecd-7ca1-985c-fa7759e10935"
  const review = "01a10e22-0000-7000-8000-00000000a001"
  const template = (await readFile(join(sessions, `rollout-2026-10-05T15-13-25-${spawned}.jsonl`), "utf8")).replaceAll(spawned, review).split("\n")
  const meta = JSON.parse(template[0])
  meta.payload.source = { subagent: "review" }
  meta.payload.thread_source = "subagent"
  meta.timestamp = meta.payload.timestamp = "2026-10-05T22:13:40.000Z"
  const rollout = join(sessions, `rollout-2026-10-05T15-13-40-${review}.jsonl`)
  await writeFile(rollout, [JSON.stringify(meta), ...template.slice(1)].join("\n"))
  // The fixture keeps only the tables a reader reads, so its rows reference tables it lacks.
  const db = new DatabaseSync(join(home, ".codex", "state_5.sqlite"), { enableForeignKeyConstraints: false })
  try {
    const columns = db.prepare("SELECT name FROM pragma_table_info('threads')").all().map((row) => row.name).filter((name) => !["id", "source", "rollout_path", "created_at_ms"].includes(name))
    db.prepare(`INSERT INTO threads (id, source, rollout_path, created_at_ms, ${columns.join(", ")}) SELECT ?, ?, ?, ?, ${columns.join(", ")} FROM threads WHERE id = ?`)
      .run(review, JSON.stringify({ subagent: "review" }), `/Users/mako/.codex/sessions/2026/10/05/rollout-2026-10-05T15-13-40-${review}.jsonl`, Date.parse("2026-10-05T22:13:40.000Z"), spawned)
  } finally {
    db.close()
  }
  const exited = "01a10e22-0000-7000-8000-00000000e001"
  await appendFile(join(sessions, `rollout-2026-10-05T15-13-20-${parent}.jsonl`), `${JSON.stringify({ timestamp: "2026-10-05T22:13:50.000Z", type: "event_msg", payload: { type: "item_completed", thread_id: parent, item: { type: "ExitedReviewMode", id: exited, review_output: { findings: [], overall_correctness: "patch is correct", overall_explanation: "Fine.", overall_confidence_score: 0.9 } } } })}\n`)
  return { review, exited }
}

/** What a harness's own delete leaves: no file and no row of the session or of its children. */
async function harnessDeletes(providers, parent, children) {
  const owner = (path) => providers.find((provider) => provider.roots().some((root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}#`)))
  for (const path of [...children].reverse()) {
    const provider = owner(path)
    const removed = await provider?.remove?.(path).catch(() => false)
    if (!removed && !path.includes("#")) await rm(path, { force: true })
  }
  const provider = owner(parent)
  const removed = await provider?.remove?.(parent).catch(() => false)
  if (!removed) for (const suffix of ["", "-wal", "-shm"]) await rm(`${parent}${suffix}`, { force: true })
  // Codex's delete drops each thread's row too; the trimmed fixture's rows name tables it lacks, which its own delete refuses.
  if (provider?.harness === "codex") {
    const db = new DatabaseSync(join(dirname(provider.roots()[0]), "state_5.sqlite"), { enableForeignKeyConstraints: false })
    try {
      const threads = db.prepare("DELETE FROM threads WHERE rollout_path LIKE '%' || ? || '.jsonl'")
      for (const path of [parent, ...children]) threads.run(/([0-9a-f-]{36})\.jsonl$/.exec(path)[1])
    } finally {
      db.close()
    }
  }
}

const shown = (thread, restoredHomes) => JSON.stringify(thread.entries).replace(restoredHomes, "<home>")
const listing = (children) => children.map((child) => [child.nativeId, child.path ?? null, child.toolId ?? null, child.state.kind, child.spawnedBy ?? null, child.title ?? null, child.role ?? null]).sort((a, b) => a[0].localeCompare(b[0]))

const totals = []
for (const harness of HARNESSES) {
  const root = await mkdtemp(join(tmpdir(), `mako-kept-children-${harness}-`))
  try {
    await cp(join(fixtures, harness), root, { recursive: true })
    const home = join(root, "home")
    const recordsPath = join(root, "records")
    const review = harness === "codex" ? await addCodexReview(home) : null
    const place = homePlace(home)
    const providers = SAVED_HISTORY_READERS.map((reader) => reader(stores, place))
    const catalogOver = () => new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(stores, place)), { recordsPath, recordsHome: home, readBack: { readers: SAVED_HISTORY_READERS, stores } })
    const homeOf = new RegExp(`${home.replaceAll("/", "\\/")}|${join(recordsPath, "restored").replaceAll("/", "\\/")}\\/[^/]+\\/[0-9a-f]{32}`, "g")
    const catalog = catalogOver()
    const parents = []
    for (const ref of await catalog.scan()) {
      const listed = await catalog.children(ref.path)
      const located = listed?.children.filter((child) => child.path) ?? []
      if (!located.length) continue
      const drawn = new Map()
      const links = new Map()
      for (const child of located) {
        const thread = await catalog.open(child.path, false)
        drawn.set(child.path, shown(thread, homeOf))
        links.set(child.path, thread.ref.childOf ?? null)
      }
      const sizes = new Map()
      // A transcript file waits; a child kept as rows or a database is restored with its parent.
      for (const child of located) if (/\.jsonl(?:\.zst)?$/.test(child.path)) sizes.set(child.path, { size: (await stat(child.path)).size, first: (await readFile(child.path, "utf8")).indexOf("\n") + 1 })
      parents.push({ ref, children: listed.children, located, drawn, links, sizes, shown: shown(await catalog.open(ref.path, false), homeOf) })
    }
    assert.ok(parents.length, `${harness}: the fixture has a parent with a child`)
    if (review) {
      const codexParent = parents.find((parent) => parent.ref.nativeId === "01a10e20-ea2e-75a1-9728-1d897d685d09")
      const listed = codexParent.children.find((child) => child.nativeId === review.review)
      assert.deepEqual([listed?.role, listed?.toolId, listed?.state.kind], ["review", review.exited, "complete"], "codex: a review is a child of the thread it reviewed, on the review's row")
    }

    // The record store holds every child with its parent, and where each is read.
    for (const parent of parents) {
      assert.equal(await catalog.hold(parent.ref.path), true, `${harness}: the store holds ${parent.ref.nativeId}`)
      const store = new RecordStore(recordsPath, stores)
      try {
        const linked = store.childPaths(parent.ref.harness, parent.ref.nativeId)
        for (const child of parent.located) assert.ok(linked.includes(child.path), `${harness}: ${child.nativeId} is kept with ${parent.ref.nativeId}: ${JSON.stringify(linked)}`)
      } finally {
        await store.close()
      }
    }

    // Its harness deletes the parent and its children.
    for (const parent of parents) await harnessDeletes(providers, parent.ref.path, parent.located.map((child) => child.path))
    await catalog.scan({ emitChanges: true })
    for (const parent of parents) {
      const kept = catalog.list().find((ref) => ref.path === parent.ref.path)
      assert.ok(kept?.archived && !kept.copyOnly, `${harness}: ${parent.ref.nativeId} is listed from Mako's records`)
      for (const child of parent.located) assert.equal(await providers.find((provider) => provider.harness === parent.ref.harness && provider.roots().some((root) => child.path.startsWith(root)))?.read(child.path).catch(() => null) ?? null, null, `${harness}: the harness keeps no ${child.nativeId}`)
      assert.equal(shown(await catalog.open(parent.ref.path, false), homeOf), parent.shown, `${harness}: ${parent.ref.nativeId} draws as it did`)
      const listed = await catalog.children(parent.ref.path)
      assert.deepEqual(listing(listed.children), listing(parent.children), `${harness}: ${parent.ref.nativeId}'s children list as they did`)
      // Read back, the parent and its list waited on no child's transcript: each is its first line until it's opened.
      const readBack = join(recordsPath, "restored", parent.ref.harness, createHash("sha256").update(parent.ref.nativeId).digest("hex").slice(0, 32))
      for (const [path, { size, first }] of parent.sizes) {
        const held = (await stat(join(readBack, relative(home, path)).replace(/\.zst$/, ""))).size
        assert.ok(held <= first && (first < size || held === size), `${harness}: ${path} waits to be opened (${held} of ${size} bytes)`)
      }
      // A transcript of the kept parent carries its children, each read from the same records.
      const opened = await catalog.open(parent.ref.path, false)
      const carried = await new ChildSidecars(join(root, "bundles", "children")).bundle({ children: (path) => catalog.children(path), open: (path) => catalog.open(path, false) }, [{ path: parent.ref.path, toolIds: toolIdsOf(opened.entries), whole: true }])
      for (const child of parent.located) assert.ok(carried.children.find((each) => each.nativeId === child.nativeId)?.transcript?.entries, `${harness}: a transcript carries ${child.nativeId}`)
      for (const child of parent.located) {
        const thread = await catalog.open(child.path, false)
        assert.ok(thread, `${harness}: ${child.nativeId} opens from its parent's records`)
        assert.equal(thread.ref.path, child.path, `${harness}: at the path it had`)
        assert.equal(thread.ref.archived, true)
        assert.deepEqual(thread.ref.childOf ?? null, parent.links.get(child.path), `${harness}: ${child.nativeId} names what started it as it did, at its own path`)
        assert.equal(shown(thread, homeOf), parent.drawn.get(child.path), `${harness}: ${child.nativeId} draws as it did`)
        const page = await catalog.page(child.path)
        assert.equal(page.total, thread.entries.length, `${harness}: ${child.nativeId} pages`)
        const cited = thread.entries.find((entry) => entry.record)
        if (cited) {
          const original = await catalog.original(child.path, cited.id)
          assert.ok(original?.parts.length, `${harness}: Show original reads ${child.nativeId}'s record from the store`)
        }
      }
    }
    await catalog.stop()

    // A fresh catalog opens a child by its path alone, as a link to it does.
    const fresh = catalogOver()
    await fresh.scan()
    for (const parent of parents) for (const child of parent.located) {
      const thread = await fresh.open(child.path, false)
      assert.equal(thread && shown(thread, homeOf), parent.drawn.get(child.path), `${harness}: a link to ${child.nativeId} resolves`)
    }

    // Captures from before captures named children: the backfill's pass links them once, and a link resolves with no parent listed.
    await fresh.stop()
    const forgetLinks = () => {
      const db = new DatabaseSync(join(recordsPath, "records.sqlite"))
      db.exec("DELETE FROM child_paths; DELETE FROM marks WHERE name = 'children linked'")
      db.close()
    }
    forgetLinks()
    const older = catalogOver()
    await older.scan()
    for (const parent of parents) assert.equal(await older.open(parent.located[0].path, false), null, `${harness}: an unnamed child isn't found by its path`)
    const linked = await older.linkChildren()
    assert.deepEqual([linked.looked, linked.parents, linked.kept, linked.failed], [parents.length, parents.length, parents.length, 0], `${harness}: the pass links every kept parent's children: ${JSON.stringify(linked)}`)
    assert.equal((await older.linkChildren()).looked, 0, `${harness}: once`)
    for (const parent of parents) for (const child of parent.located)
      assert.equal(shown(await older.open(child.path, false), homeOf), parent.drawn.get(child.path), `${harness}: then a link to ${child.nativeId} resolves`)
    await older.stop()
    if (harness === "claude") {
      // Or listing the parent links them, before any pass.
      forgetLinks()
      const listing = catalogOver()
      await listing.scan()
      const [parent] = parents
      assert.equal((await listing.children(parent.ref.path)).children.length, parent.children.length)
      await listing.stop()
      const relinked = catalogOver()
      await relinked.scan()
      assert.ok(await relinked.open(parent.located[0].path, false), "claude: once listed, it is")
      await relinked.stop()
    }

    // A reply restores the parent: its children come back with it, and the harness's own reader has them.
    const restoring = catalogOver()
    await restoring.scan()
    for (const parent of parents) {
      const restored = await restoring.restoreKept(parent.ref.path)
      assert.equal(restored.kind, "restored", `${harness}: ${parent.ref.nativeId} restores: ${JSON.stringify(restored)}`)
      // The moment it returns, the catalog's own readers list and open its children from the harness's store.
      const relisted = await restoring.children(parent.ref.path)
      assert.deepEqual(listing(relisted.children), listing(parent.children), `${harness}: the catalog lists ${parent.ref.nativeId}'s children from its harness at once`)
      for (const child of parent.located) {
        const opened = await restoring.open(child.path, false)
        assert.equal(opened?.ref.archived, undefined, `${harness}: ${child.nativeId} opens from its harness at once`)
        assert.equal(shown(opened, homeOf), parent.drawn.get(child.path), `${harness}: and draws as it did`)
      }
      // The harness's own reader, as a resume opens it: one made now, with nothing listed before the restore.
      const provider = SAVED_HISTORY_READERS.map((reader) => reader(stores, place)).find((candidate) => candidate.harness === parent.ref.harness && candidate.roots().some((root) => parent.ref.path.startsWith(root)))
      const native = await provider.children(parent.ref.path)
      assert.deepEqual(listing(native), listing(parent.children), `${harness}: its harness lists ${parent.ref.nativeId}'s children again`)
      for (const child of parent.located) {
        const read = await provider.read(child.path)
        assert.equal(read && shown(read, homeOf), parent.drawn.get(child.path), `${harness}: its harness reads ${child.nativeId} again`)
      }
      assert.deepEqual(await restoring.restoreKept(parent.ref.path), { kind: "present", path: parent.ref.path }, `${harness}: a restore asked again writes nothing`)
      totals.push(`${harness} ${parent.ref.nativeId.slice(0, 8)}: ${parent.located.length} of ${parent.children.length} children, ${restored.files} files and ${restored.rows} rows restored`)
    }

    // Deleted by its harness again, then by the person: Mako forgets the parent and its children.
    for (const parent of parents) await harnessDeletes(providers, parent.ref.path, parent.located.map((child) => child.path))
    await restoring.scan({ emitChanges: true })
    const events = []
    restoring.onChange?.((event) => events.push(event))
    for (const parent of parents) {
      assert.ok(restoring.list().some((ref) => ref.path === parent.ref.path && ref.archived), `${harness}: kept again`)
      assert.equal(await restoring.remove(parent.ref.path), true, `${harness}: the person deletes ${parent.ref.nativeId}`)
      assert.ok(!restoring.list().some((ref) => ref.path === parent.ref.path), `${harness}: no longer listed`)
      for (const child of parent.located) assert.equal(await restoring.open(child.path, false), null, `${harness}: ${child.nativeId} is forgotten with it`)
    }
    await restoring.stop()
    const store = new RecordStore(recordsPath, stores)
    try {
      for (const parent of parents) {
        assert.equal(store.units(parent.ref.harness, parent.ref.nativeId).length, 0, `${harness}: no record of ${parent.ref.nativeId} is left`)
        for (const child of parent.located) assert.equal(store.parentAt(child.path), null, `${harness}: nor of ${child.nativeId}`)
      }
    } finally {
      await store.close()
    }
    const restoredHomes = join(recordsPath, "restored", harness)
    assert.deepEqual(existsSync(restoredHomes) ? await readdir(restoredHomes) : [], [], `${harness}: nor any home it was read back into`)
    const after = catalogOver()
    await after.scan()
    for (const parent of parents) assert.ok(!after.list().some((ref) => ref.path === parent.ref.path), `${harness}: a new catalog lists none of it`)
    await after.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
console.log(`kept children: on ${HARNESSES.join(", ")}, a parent its harness deleted lists its children from Mako's records, each opens and draws as it did at its own path, a restore writes them back with it, and the person's delete forgets them\n  ${totals.join("\n  ")}`)
