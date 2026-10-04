import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Actor } from "../electron/contracts/thread-identity.js"
import { ThreadStore } from "../electron/thread-store.js"

/**
 * A Thread's own name: a rename names the whole Thread, however many
 * Sessions it holds, and survives a restart; dropping it shows the first
 * Session's title again; another host hears of it; old window renames and
 * setup names are kept; and a title an older build wrote automatically is
 * no longer shown.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-names-")))
const migration: Actor = { kind: "service", name: "migration" }

function openStore(name: string): ThreadStore {
  return new ThreadStore(join(root, `${name}.sqlite`), { realPath: (path) => path })
}

function newThread(store: ThreadStore, harness = "claude") {
  const conversation = randomUUID()
  const placed = store.registerJournal({ conversationId: conversation, createdAt: Date.now(), harness, bindings: [] }, migration)
  return { conversation, thread: placed.thread, session: placed.session }
}

try {
  const path = join(root, "names.sqlite")
  const store = new ThreadStore(path, { realPath: (value) => value })
  const first = newThread(store)
  const tab = store.createSession({ operationId: randomUUID(), thread: first.thread, actor: store.person() })
  store.registerJournal({ conversationId: randomUUID(), createdAt: Date.now(), harness: "codex", bindings: [], session: tab.session }, migration)
  assert.deepEqual(store.thread(first.thread)?.sessions, [first.session, tab.session])
  assert.deepEqual(store.titleEntry(first.thread), { thread: first.thread, title: null }, "an unnamed Thread shows its first Session's title")

  const renamed = store.renameThread({ operationId: randomUUID(), thread: first.thread, title: "  Billing webhooks ", original: "Ship the billing webhooks", actor: store.person() })
  assert.equal(renamed.title, "Billing webhooks")
  assert.deepEqual(renamed.sessions, [first.session, tab.session], "renaming names the Thread and leaves its Sessions as they were")
  assert.equal(store.sessionPlacement(tab.session)?.thread, first.thread, "the second Session is still in the renamed Thread")
  assert.deepEqual(store.titleEntry(first.thread), { thread: first.thread, title: "Billing webhooks", source: "user" })
  assert.equal(store.originalTitle(first.thread), "Ship the billing webhooks", "the name it showed before is kept")
  assert.throws(() => store.renameThread({ operationId: randomUUID(), thread: first.thread, title: "   ", actor: store.person() }), /cannot be empty/)
  store.close()

  const again = new ThreadStore(path, { realPath: (value) => value })
  assert.deepEqual(again.titleEntry(first.thread), { thread: first.thread, title: "Billing webhooks", source: "user" }, "a rename survives a restart")
  assert.deepEqual(again.titles(), [{ thread: first.thread, title: "Billing webhooks", source: "user" }])
  assert.deepEqual(again.clearThreadTitle({ operationId: randomUUID(), thread: first.thread, actor: again.person() }), { thread: first.thread, title: null },
    "dropping the name shows the first Session's title again")
  assert.deepEqual(again.titles(), [])
  again.close()

  // Another host's rename reaches this host's windows, once.
  const one = openStore("hosts")
  const two = openStore("hosts")
  const shared = newThread(one)
  two.takeExternalTitles()
  one.renameThread({ operationId: randomUUID(), thread: shared.thread, title: "Shared name", actor: one.person() })
  assert.deepEqual(two.takeExternalTitles(), [{ thread: shared.thread, title: "Shared name", source: "user" }])
  assert.deepEqual(two.takeExternalTitles(), [], "once")
  assert.deepEqual(one.takeExternalTitles(), [], "a host's own change is not news to it")
  one.close()
  two.close()

  // Old window renames are the person's; a setup Thread keeps Mako's name.
  const kept = openStore("kept")
  const windowRenamed = newThread(kept)
  const setup = newThread(kept)
  assert.deepEqual(kept.importThreadTitles([{ thread: windowRenamed.thread, title: "Old window name" }]),
    [{ thread: windowRenamed.thread, title: "Old window name", source: "user" }])
  assert.deepEqual(kept.importThreadTitles([{ thread: windowRenamed.thread, title: "Another" }]), [], "importing twice changes nothing")
  assert.equal(kept.keepThreadTitle(setup.thread, "Set up mako")?.source, "frozen")
  assert.equal(kept.keepThreadTitle(setup.thread, "Something else")?.title, "Set up mako", "a Thread with a name keeps it")
  kept.close()

  // Titles an older build wrote: an automatic one isn't shown, an unsourced one is the user's.
  const old = join(root, "older.sqlite")
  const seeded = new ThreadStore(old)
  const automatic = newThread(seeded)
  const automaticInTitle = newThread(seeded)
  const unsourced = newThread(seeded)
  seeded.close()
  const db = new DatabaseSync(old)
  db.prepare("UPDATE threads SET auto_title = 'Parser work' WHERE id = ?").run(automatic.thread)
  db.prepare("UPDATE threads SET title = 'Lexer work', title_source = 'auto' WHERE id = ?").run(automaticInTitle.thread)
  db.prepare("UPDATE threads SET title = 'Named elsewhere', title_source = NULL WHERE id = ?").run(unsourced.thread)
  db.close()
  const reopened = new ThreadStore(old)
  assert.deepEqual(reopened.titleEntry(automatic.thread), { thread: automatic.thread, title: null }, "an automatic title is no longer shown")
  assert.deepEqual(reopened.titleEntry(automaticInTitle.thread), { thread: automaticInTitle.thread, title: null })
  assert.deepEqual(reopened.titleEntry(unsourced.thread), { thread: unsourced.thread, title: "Named elsewhere", source: "user" }, "a title without a source is the user's")
  assert.deepEqual(reopened.titles(), [{ thread: unsourced.thread, title: "Named elsewhere", source: "user" }])
  assert.deepEqual(reopened.importThreadTitles([{ thread: automaticInTitle.thread, title: "Lexer rewrite" }]),
    [{ thread: automaticInTitle.thread, title: "Lexer rewrite", source: "user" }], "an old window rename replaces an automatic title")
  reopened.close()

  console.log("thread names: a multi-Session rename names the Thread, restart, dropping a name, other hosts, window renames, setup names, older builds' titles")
} finally {
  rmSync(root, { recursive: true, force: true })
}
