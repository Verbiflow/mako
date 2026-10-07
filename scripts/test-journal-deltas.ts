import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { LiveJournal } from "../electron/live-journal"
import { reduceLiveUpdates } from "../electron/contracts/live-content"
import { ConversationControlSchema } from "../electron/contracts/conversation-control"
import { auditSnapshot } from "./performance-audit-fixtures"

const root = await mkdtemp(join(tmpdir(), "mako-journal-deltas-"))
let snapshot = auditSnapshot(2, "fixture", 524288, 0)
let journal = new LiveJournal(root, snapshot.session.id)
try {
  journal.commit(snapshot)
  for (const text of [
    " next",
    "\ud835",
    "\udc9c",
    ...Array.from({ length: 24 }, () => " tail"),
  ]) {
    const previous = snapshot
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      blocks: reduceLiveUpdates(snapshot.blocks, [
        { kind: "text", id: "text-1", text },
      ]),
    }
    journal.commit(snapshot, previous)
  }
  const raw = new DatabaseSync(join(root, `${snapshot.session.id}.sqlite`), {
    readOnly: true,
  })
  try {
    const row = raw
      .prepare(
        "SELECT count(*) AS count, sum(length(value)) AS bytes FROM block_appends"
      )
      .get()
    assert.ok(
      row && Number(row.count) > 0 && Number(row.bytes) < 4096,
      "Growing text must persist small deltas instead of repeated half-megabyte prefixes"
    )
  } finally {
    raw.close()
  }
  journal.close()
  journal = new LiveJournal(root, snapshot.session.id)
  assert.deepEqual(journal.read()?.blocks, snapshot.blocks)
  const usage = { used: 40_000, size: 200_000, tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 1 }, cost: { amount: 0.5, currency: "USD" } }
  const metered = { ...snapshot, revision: snapshot.revision + 1, session: { ...snapshot.session, usage } }
  journal.commit(metered, snapshot)
  snapshot = metered
  journal.close()
  journal = new LiveJournal(root, snapshot.session.id)
  assert.deepEqual(journal.read()?.session.usage, { used: 40_000, size: 200_000 }, "A restart reopens the conversation as full as it was, without the ended process's spend")
  const writer = new DatabaseSync(join(root, `${snapshot.session.id}.sqlite`))
  const rejected = {
    ...snapshot,
    revision: snapshot.revision + 1,
    blocks: reduceLiveUpdates(snapshot.blocks, [
      { kind: "text", id: "text-1", text: " retry" },
    ]),
  }
  try {
    writer.exec(
      "CREATE TRIGGER reject_append BEFORE INSERT ON block_appends BEGIN SELECT RAISE(ABORT, 'fixture append refusal'); END"
    )
    assert.throws(
      () => journal.commit(rejected, snapshot),
      /fixture append refusal/
    )
    assert.deepEqual(journal.read()?.blocks, snapshot.blocks)
    writer.exec("DROP TRIGGER reject_append")
    journal.commit(rejected, snapshot)
    snapshot = rejected
    for (let index = 0; index < 140; index++) {
      const previous = snapshot
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        blocks: reduceLiveUpdates(snapshot.blocks, [
          { kind: "text", id: "text-1", text: " more" },
        ]),
      }
      journal.commit(snapshot, previous)
    }
    assert.deepEqual(journal.read()?.blocks, snapshot.blocks)
    const row = writer
      .prepare("SELECT count(*) AS count FROM block_appends")
      .get()
    assert.ok(
      row && Number(row.count) <= 128,
      "Append replay remains bounded by compaction"
    )
  } finally {
    writer.close()
  }
  const before = snapshot
  snapshot = {
    ...snapshot,
    blocks: reduceLiveUpdates(snapshot.blocks, [
      { kind: "text", id: "text-1", text: "rewritten", replace: true },
    ]),
  }
  journal.commit(snapshot, before)
  assert.deepEqual(journal.read()?.blocks, snapshot.blocks)
  const shorter = {
    ...snapshot,
    blocks: snapshot.blocks.slice(0, 2),
    session: { ...snapshot.session, status: "ready" as const },
  }
  journal.commit(shorter, snapshot)
  assert.deepEqual(journal.read()?.blocks, shorter.blocks)
  snapshot = shorter

  // A harness's model list rides in its own row: a status change leaves it alone.
  const configOptions = [{ kind: "select" as const, id: "model", label: "Model", current: "m0", values: Array.from({ length: 721 }, (_, index) => ({ value: `m${index}`, label: `Model ${index}`, description: "A model choice with a description" })) }]
  const commands = [{ name: "review", description: "Review the change" }]
  const listed = { ...snapshot, revision: snapshot.revision + 1, session: { ...snapshot.session, configOptions, commands } }
  journal.commit(listed, snapshot)
  const inspect = new DatabaseSync(join(root, `${snapshot.session.id}.sqlite`))
  const optionsBytes = () => Number(inspect.prepare("SELECT length(value) AS bytes FROM options WHERE id=1").get()?.bytes ?? 0)
  const metadataRow = () => String(inspect.prepare("SELECT value FROM metadata WHERE id=1").get()?.value)
  try {
    assert.ok(optionsBytes() > 30_000 && metadataRow().length < 4_000, "Model options are stored apart from the session")
    assert.ok(!metadataRow().includes("Review the change"), "Commands are not stored; nothing reads them back")
    inspect.exec("CREATE TABLE option_writes (n INTEGER); CREATE TRIGGER count_options AFTER INSERT ON options BEGIN INSERT INTO option_writes VALUES (1); END")
    const running = { ...listed, revision: listed.revision + 1, session: { ...listed.session, status: "running" as const } }
    journal.commit(running, listed)
    assert.equal(Number(inspect.prepare("SELECT count(*) AS n FROM option_writes").get()?.n), 0, "A status change does not rewrite the model options")
    inspect.exec("DROP TRIGGER count_options; DROP TABLE option_writes")
    journal.close()
    journal = new LiveJournal(root, snapshot.session.id)
    assert.deepEqual(journal.read()?.session.configOptions, configOptions, "Options read back with the session")
    assert.deepEqual(journal.summary()?.session.configOptions, configOptions, "A summary carries the options too")
    snapshot = running

    // A journal from before the split keeps its options inline until its next commit moves them.
    inspect.exec("DELETE FROM options")
    const legacy = JSON.parse(metadataRow())
    legacy.session.configOptions = configOptions
    inspect.prepare("UPDATE metadata SET value=? WHERE id=1").run(JSON.stringify(legacy))
    journal.close()
    journal = new LiveJournal(root, snapshot.session.id)
    const reopened = journal.read()!
    assert.deepEqual(reopened.session.configOptions, configOptions, "An older journal reads its inline options")
    const ready = { ...reopened, revision: reopened.revision + 1, session: { ...reopened.session, status: "ready" as const } }
    journal.commit(ready, reopened)
    journal.close()
    journal = new LiveJournal(root, snapshot.session.id)
    assert.deepEqual(journal.read()?.session.configOptions, configOptions, "Moving options out of an older journal keeps them")
    assert.ok(optionsBytes() > 30_000 && metadataRow().length < 4_000)

    const reread = journal.read()!
    const native = { tokens: { input: 6, cacheRead: 54_381, cacheWrite: 31_686, output: 27 }, cost: 0.6487 }
    const usage = { used: 30_000, size: 200_000, tokens: { input: 2, cacheRead: 26_104, cacheWrite: 4_551, output: 11 }, cost: { amount: 0.0981, currency: "USD" }, native }
    journal.commit({ ...reread, revision: reread.revision + 1, session: { ...reread.session, usage } }, reread)
    journal.close()
    journal = new LiveJournal(root, snapshot.session.id)
    assert.deepEqual(journal.read()?.session.usage, { used: 30_000, size: 200_000, native }, "The context and the harness's session totals reopen; the process's spend does not")

    const withUsage = journal.read()!
    const left = { id: randomUUID(), provider: "claude", nativeId: "claude-session", coveredBlocks: 0, includesBase: true, nativeUsage: native }
    const active = { id: randomUUID(), provider: "codex", nativeId: "codex-thread", coveredBlocks: 0, includesBase: true }
    const control = ConversationControlSchema.parse({ ...withUsage.control, activeBindingId: active.id, bindings: [left, active], transfers: [] })
    journal.commit({ ...withUsage, revision: withUsage.revision + 1, control }, withUsage)
    journal.close()
    journal = new LiveJournal(root, snapshot.session.id)
    assert.deepEqual(journal.read()?.control?.bindings[0].nativeUsage, native, "A binding the conversation left keeps its native session's totals")
  } finally {
    inspect.close()
  }
  console.log(
    "Journal deltas: bounded prefix writes, reopen, split Unicode, authoritative replacement, truncation, model options apart from the session, and session totals kept for a resume"
  )
} finally {
  journal.close()
  await rm(root, { recursive: true, force: true })
}
