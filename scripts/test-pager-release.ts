import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadPage } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { EntryPager, isPaged, type PagedRows } from "@mako/host/conversations/paged-entries"

/**
 * A closed journal goes once nothing holds its paged entries: its pager hears each collected and lets the journal,
 * its read connection and what it cached go. The read-back cache was keyed by the entries themselves, so an entry
 * read back once (a window opening the conversation, a merge) stayed reachable through the cache, the count never
 * reached zero and the journal never went. On a clone of the person's stores, opening 60 conversations and letting
 * the budget unload them left 80 pagers in `LiveRecords.releasing` holding 18 MB of cache, beside their 79 journals'
 * 32 MB (2026-11-12). The closed journal also kept its history's rows by identity (`baseRows`), so the entries it had
 * paged had a holder in the very journal waiting for them to go. Run with `--expose-gc`.
 */

const exposed = globalThis.gc
if (!exposed) throw new Error("run with --expose-gc")
const gc: () => void = exposed
const text = "x".repeat(4_000)
const rows: Record<number, string> = {}
let closed = 0
const source: PagedRows = { read: (_table, row) => rows[row], close: () => { closed++ } }

/** Collects until `done` says so, or gives up: finalization callbacks run after a collection, on a later turn. */
async function settles(done: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 40 && !done(); attempt++) {
    gc()
    await new Promise((resume) => setTimeout(resume, 10))
  }
  return done()
}

for (const readBack of [false, true]) {
  const pager = new EntryPager(source)
  closed = 0
  // Entries paged and dropped by everything but the pager; with `readBack`, each read back once first, as a window does.
  ;(() => {
    const held: Entry[] = []
    for (let row = 0; row < 50; row++) {
      const entry: Entry = { type: "text", id: `m${row}`, text: `${text}${row}` }
      rows[row] = JSON.stringify(entry)
      held.push(pager.page(entry, "base", row))
    }
    if (readBack) for (const [row, paged] of held.entries()) assert.equal(paged.type === "text" && paged.text.length, text.length + String(row).length)
  })()
  let released = false
  void pager.release(source).then(() => { released = true })
  const went = await settles(() => released)
  assert.ok(went, `a closed journal whose entries nothing holds is released${readBack ? ", after its entries were read back" : ""}`)
  assert.equal(closed, 1, "its read connection closes")
  assert.equal(pager.pagedCount(), 0)
}

// A journal whose history's entries were paged, closed with nothing else holding them, goes.
const root = mkdtempSync(join(tmpdir(), "mako-pager-release-"))
try {
  const id = randomUUID()
  const journal = new LiveJournal(join(root, "journal"), id)
  let released = false
  ;(() => {
    const page: ThreadPage = {
      ref: { harness: "test-provider", nativeId: "native-1", path: join(root, "session.jsonl"), title: "A session", cwd: "/tmp" },
      entries: Array.from({ length: 40 }, (_, index): Entry => ({ type: "text", id: `entry-${index}`, text: `${text}${index}` })),
      start: 0, total: 40, hasEarlier: false,
    }
    const snapshot: LiveSnapshot = {
      session: { id, harness: "test-provider", cwd: "/tmp", status: "ready", connection: "disconnected", modes: [], currentMode: null, configOptions: [] },
      revision: 1, createdAt: 1, base: page, blocks: [], permissions: [], requests: [],
    }
    journal.commit(snapshot)
    journal.pageBase(page.entries, 0, page.entries.length, Infinity)
    assert.ok(page.entries.every(isPaged))
    assert.equal(page.entries[3]!.type === "text" && page.entries[3]!.text.length, text.length + 1, "read back once")
    journal.close()
  })()
  void journal.released().then(() => { released = true })
  assert.ok(await settles(() => released), "a closed journal whose paged history nothing else holds is released")
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log("pager release: a closed journal goes once nothing holds its paged entries, whether or not they were read back, and a journal's own rows don't hold them")
