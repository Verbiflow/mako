import assert from "node:assert/strict"
import { z } from "zod"
import { fork } from "node:child_process"
import { mock } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { JournalWriter } from "@mako/host/conversations/journal-writer"
import { JournalReaders } from "@mako/host/conversations/journal-readers"
import { buildTurnIndex, coldScan, JournalWriteError, LiveJournal, readTurnIndex } from "@mako/host/conversations/live-journal"
import { auditSnapshot } from "./performance-audit-fixtures.ts"

/**
 * A running turn's streamed flushes written by the journal writer (`npm run test:journal-writer`): the rows a reader
 * finds are the ones a commit on the journal's own connection would have left, in order, through a reader that follows
 * a write, a close and a stop with writes still waiting, a write that fails on the writer, and a host killed mid-stream
 * (everything it had settled is there, and what is there is a run of flushes with none missing).
 */
const WORD = (at: number) => `w${at} `

/** A journal with a running turn already committed on its own connection, and its next streamed flush. */
function streaming(root: string, writer: JournalWriter | undefined) {
  const first = auditSnapshot(0)
  const journal = new LiveJournal(root, first.session.id)
  let snapshot: LiveSnapshot = { ...first, blocks: [{ type: "text", id: "answer", text: "" }], revision: first.revision + 1 }
  journal.commit(snapshot)
  if (writer) journal.writeWith(writer)
  let words = 0
  return {
    journal,
    id: first.session.id,
    snapshot: () => snapshot,
    words: () => words,
    /** One more word of the answer, and every third flush a call's output growing beside it. */
    flush() {
      const previous = snapshot
      const [answer, ...rest] = previous.blocks
      assert.ok(answer?.type === "text")
      const blocks: LiveSnapshot["blocks"] = [{ ...answer, text: answer.text + WORD(words) }, ...rest]
      if (words % 3 === 2) blocks.push({ type: "tool", id: `call-${words}`, name: "Bash", status: "completed", input: "ls", output: `listing ${words}` })
      // And now and then a block the turn index has a line for: a message the person steered in.
      if (words % 7 === 6) blocks.push({ type: "user", id: `steer-${words}`, text: "and this", requestId: `request-${words}`, steeringFor: "request-0" })
      words += 1
      snapshot = { ...previous, blocks, revision: previous.revision + 1 }
      journal.commit(snapshot, previous)
    },
    /** A change only the journal's own connection commits: the turn's end. */
    end() {
      const previous = snapshot
      snapshot = { ...previous, session: { ...previous.session, status: "ready" }, revision: previous.revision + 1 }
      journal.commit(snapshot, previous)
    },
  }
}

/** What a walk of the journal's blocks says, and what its turn index says (undefined while it doesn't hold every block). */
function scans(root: string, id: string) {
  const db = new DatabaseSync(join(root, `${id}.sqlite`))
  try {
    return { walked: coldScan(db), indexed: readTurnIndex(db) }
  } finally {
    db.close()
  }
}

/** What a new host reads of the journal. */
function reopened(root: string, id: string): LiveSnapshot["blocks"] {
  const journal = new LiveJournal(root, id)
  try {
    return journal.read()?.blocks ?? []
  } finally {
    void journal.close()
  }
}

if (process.argv[2] === "stream") {
  // The host that is killed: it streams without end, and says each count it knows written.
  const writer = new JournalWriter()
  assert.ok(await writer.started())
  const turn = streaming(process.argv[3]!, writer)
  // Its turn index is whole from the start, so every block it streams writes its line with it.
  assert.ok(buildTurnIndex(turn.journal["connection"], coldScan(turn.journal["connection"])))
  turn.journal["indexed"] = true
  for (;;) {
    for (let burst = 0; burst < 5; burst += 1) turn.flush()
    if (turn.words() % 25 === 0) {
      turn.journal["settleWrites"]()
      process.send?.({ settled: turn.words() })
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

const root = mkdtempSync(join(tmpdir(), "mako-journal-writer-"))
try {
  // The same flushes leave the same rows, written by the writer or by the journal itself, and a reader of the
  // journal's rows waits for the write it follows.
  {
    const writer = new JournalWriter()
    assert.ok(await writer.started())
    const mine = streaming(join(root, "own"), undefined), theirs = streaming(join(root, "writer"), writer)
    let handed = 0
    const streamed = theirs.journal["streamed"].bind(theirs.journal)
    theirs.journal["streamed"] = (...args) => { const took = streamed(...args); if (took) handed += 1; return took }
    for (let flush = 0; flush < 300; flush += 1) {
      mine.flush()
      theirs.flush()
      // Past 128 appends a block is written whole, by either.
      if (flush === 150) assert.deepEqual(theirs.journal.read()?.blocks, theirs.snapshot().blocks, "a read follows the writes given before it")
    }
    assert.equal(handed, 300, "every streamed flush of a running turn went to the writer")
    assert.deepEqual(theirs.journal.read()?.blocks, theirs.snapshot().blocks)
    assert.deepEqual(theirs.journal.read()?.blocks, mine.journal.read()?.blocks, "the rows are the ones the journal's own commits leave")
    mine.end()
    theirs.end()
    // At rest, a flush that changes something kept is the journal's own commit; one that changes nothing kept (a
    // roster of Fins moved) has only its revision to write, which the writer takes.
    const rest = theirs.snapshot()
    assert.equal(theirs.journal["streamed"]({ ...rest, revision: rest.revision + 1, blocks: [...rest.blocks, { type: "text", id: "later", text: "more" }] }, rest, undefined), false, "a turn at rest commits what it keeps on its own connection")
    assert.equal(theirs.journal["streamed"]({ ...rest, revision: rest.revision + 5 }, rest, undefined), true, "a flush that changes nothing kept hands its revision to the writer")
    assert.equal(theirs.journal.summary()?.revision, rest.revision + 5, "and a read of the journal follows it")
    assert.deepEqual(theirs.journal.read(), mine.journal.read() && { ...mine.journal.read()!, session: theirs.journal.read()!.session, revision: rest.revision + 5 })
    await Promise.all([mine.journal.close(), theirs.journal.close()])
    assert.deepEqual(reopened(join(root, "writer"), theirs.id), theirs.snapshot().blocks)
    await writer.stop()
  }

  // The writer answers between `settle`'s look at its count and its wait for the count to move: the wait is for a
  // change from what it looked at, so it sees the answer and goes on at once. Waiting instead for a change from the
  // count as it stands after the answer held the host's thread `SETTLE_MS` (30 s) with everything written.
  {
    const writer = new JournalWriter()
    assert.ok(await writer.started())
    const turn = streaming(join(root, "answered-between"), writer)
    turn.flush()
    turn.journal["settleWrites"]()
    turn.flush()
    const [handle] = writer["handles"].values()
    assert.ok(handle && handle.posted === 2, "a second write is on its way")
    const { cell, posted } = handle
    const load = Atomics.load.bind(Atomics)
    let looks = 0
    let looked = false
    // The journal asks first whether anything is pending (`pending`), then `settle` looks at the count: that look reads
    // the count from before the answer, which then comes before it looks again.
    const late = mock.method(Atomics, "load", (array: Int32Array, index: number) => {
      if (array !== cell || index !== 0 || (looks += 1) !== 2) return load(array, index)
      looked = true
      while (load(cell, 0) < posted) Atomics.wait(cell, 0, load(cell, 0), 10)
      return posted - 1
    })
    const began = performance.now()
    try {
      turn.journal["settleWrites"]()
    } finally {
      late.mock.restore()
    }
    const held = performance.now() - began
    assert.ok(looked, "settle looked at the count")
    assert.ok(held < 1_000, `settle held the host's thread ${Math.round(held)} ms for an answer that had come`)
    assert.ok(turn.journal["writes"], "and the journal still writes through the writer")
    turn.end()
    await turn.journal.close()
    assert.deepEqual(reopened(join(root, "answered-between"), turn.id), turn.snapshot().blocks)
    await writer.stop()
  }

  // A writer whose thread is still starting: nothing waits for it on the host's thread, whose wait nobody bounds and
  // which can't hear the thread start, fail or exit while it waits. Its journal writes its own rows meanwhile, and
  // hands its streamed flushes to the writer once the writer says it runs.
  {
    const writer = new JournalWriter(new URL("./lib/journal-writer-slow-worker.ts", import.meta.url))
    const turn = streaming(join(root, "starting"), writer)
    let held = 0
    const timed = (step: () => void) => {
      const began = performance.now()
      step()
      held = Math.max(held, performance.now() - began)
    }
    for (let flush = 0; flush < 20; flush += 1) timed(() => turn.flush())
    timed(() => turn.end())
    assert.ok(held < 1_000, `a commit held the host's thread ${Math.round(held)} ms for a writer still starting`)
    assert.equal(turn.journal["writes"], undefined, "a journal writes its own rows while its writer starts")
    assert.deepEqual(turn.journal.read()?.blocks, turn.snapshot().blocks)
    assert.ok(await writer.started(), "the writer starts")
    const rest = turn.snapshot()
    turn.journal.commit({ ...rest, revision: rest.revision + 1 }, rest)
    assert.ok(turn.journal["writes"], "once it runs, the journal's next streamed flush goes to it")
    assert.equal(turn.journal.summary()?.revision, rest.revision + 1)
    await turn.journal.close()
    assert.deepEqual(reopened(join(root, "starting"), turn.id), turn.snapshot().blocks)
    await writer.stop()
  }

  // Closed with writes still waiting, and the writer stopped right after: a new host reads every flush.
  {
    const writer = new JournalWriter()
    assert.ok(await writer.started())
    const turn = streaming(join(root, "closed"), writer)
    for (let flush = 0; flush < 200; flush += 1) turn.flush()
    const closing = turn.journal.close()
    const stopping = writer.stop()
    await Promise.all([closing, stopping])
    assert.deepEqual(reopened(join(root, "closed"), turn.id), turn.snapshot().blocks, "a close writes what was waiting before it closes")
  }

  // The writer stopped under a journal still streaming: the journal writes its own from there, with nothing lost.
  {
    const writer = new JournalWriter()
    assert.ok(await writer.started())
    const turn = streaming(join(root, "stopped"), writer)
    for (let flush = 0; flush < 50; flush += 1) turn.flush()
    await writer.stop()
    for (let flush = 0; flush < 50; flush += 1) turn.flush()
    turn.end()
    assert.deepEqual(turn.journal.read()?.blocks, turn.snapshot().blocks)
    await turn.journal.close()
    assert.deepEqual(reopened(join(root, "stopped"), turn.id), turn.snapshot().blocks, "a journal whose writer is gone writes what it was given itself")
  }

  // Every journal's writes closed at once, awaited, as the host stops: what each was given is written, a journal that
  // streams after writes its own rows, and its close waits for nothing of the writer's.
  {
    const writer = new JournalWriter()
    assert.ok(await writer.started())
    const turns = [0, 1, 2].map((at) => streaming(join(root, `closed-${at}`), writer))
    for (let flush = 0; flush < 60; flush += 1) for (const turn of turns) turn.flush()
    await writer.closeAll()
    for (const turn of turns) {
      assert.equal(turn.journal["writes"]?.pending(), false, "nothing of it waits on the writer")
      assert.equal(turn.journal["writes"]?.closed(), true)
    }
    // Read on a connection of its own: all of it is in the file, with no word from the journal.
    const db = new DatabaseSync(join(root, "closed-0", `${turns[0]!.id}.sqlite`), { readOnly: true })
    assert.equal(z.object({ revision: z.number() }).parse(db.prepare("SELECT revision FROM progress WHERE id=1").get()).revision, turns[0]!.snapshot().revision)
    db.close()
    for (let flush = 0; flush < 20; flush += 1) turns[1]!.flush()
    assert.equal(turns[1]!.journal["writes"], undefined, "a journal that streams after writes its own")
    for (const [at, turn] of turns.entries()) {
      turn.end()
      await turn.journal.close()
      assert.deepEqual(reopened(join(root, `closed-${at}`), turn.id), turn.snapshot().blocks)
    }
    await writer.stop()
  }

  // The writer holds a journal's connection only while it streams: none for one read in and at rest, one from its
  // first streamed flush, let go at rest without waiting on the thread, and opened again at the next turn.
  {
    const writer = new JournalWriter()
    assert.ok(await writer.started())
    const turn = streaming(join(root, "lazy"), writer)
    assert.equal(turn.journal["writes"], undefined, "given the writer, a journal opens nothing on it until it streams")
    for (let flush = 0; flush < 30; flush += 1) turn.flush()
    assert.ok(turn.journal["writes"], "its first streamed flush opens its writes")
    turn.end()
    turn.journal.rest()
    assert.equal(turn.journal["writes"], undefined, "at rest its writes are let go")
    assert.equal(writer["handles"].size, 1, "the writer still closes it, off the thread")
    await turn.journal["left"]
    assert.equal(writer["handles"].size, 0, "and then holds nothing of it")
    assert.deepEqual(turn.journal.read()?.blocks, turn.snapshot().blocks)
    const rested = turn.snapshot()
    assert.equal(turn.journal["streamed"]({ ...rested, revision: rested.revision + 1 }, rested, undefined), true, "the next streamed flush opens them again")
    assert.equal(writer["handles"].size, 1)
    await turn.journal.close()
    assert.equal(writer["handles"].size, 0, "a close lets go of them, awaited before it settles")
    assert.equal(reopened(join(root, "lazy"), turn.id).length, turn.snapshot().blocks.length)
    await writer.stop()
  }

  // A write that fails on the writer (a row it can't insert): the journal writes each block whole from memory and
  // goes on writing its own. One the journal can't make good either is a commit that failed, as it always was.
  {
    const writer = new JournalWriter()
    assert.ok(await writer.started())
    const turn = streaming(join(root, "failed"), writer)
    for (let flush = 0; flush < 10; flush += 1) turn.flush()
    turn.journal["settleWrites"]()
    const other = new DatabaseSync(join(root, "failed", `${turn.id}.sqlite`))
    // The place the answer's next append takes is taken: the writer's insert fails.
    other.prepare("INSERT INTO block_appends VALUES (0, 10, ?)").run(JSON.stringify("stray"))
    for (let flush = 0; flush < 10; flush += 1) turn.flush()
    assert.deepEqual(turn.journal.read()?.blocks, turn.snapshot().blocks, "what the writer couldn't write, the journal wrote")
    assert.equal(turn.journal["writes"], undefined, "and it writes its own from there")
    turn.flush()
    turn.end()
    assert.deepEqual(reopened(join(root, "failed"), turn.id), turn.snapshot().blocks)

    const lost = streaming(join(root, "lost"), writer)
    for (let flush = 0; flush < 5; flush += 1) lost.flush()
    lost.journal["settleWrites"]()
    const broken = new DatabaseSync(join(root, "lost", `${lost.id}.sqlite`))
    broken.exec("DROP TABLE block_appends")
    broken.close()
    lost.flush()
    assert.throws(() => lost.end(), JournalWriteError, "a journal that can't be written at all fails its commit")
    other.close()
    await writer.stop()
  }

  // A host killed mid-stream: every flush it knew written is there, and what is there is a run of flushes from the first.
  {
    const folder = join(root, "killed")
    const child = fork(new URL(import.meta.url), ["stream", folder], { execArgv: process.execArgv, stdio: ["ignore", "inherit", "inherit", "ipc"] })
    let settled = 0
    child.on("message", (message: { settled?: number }) => { settled = Math.max(settled, message.settled ?? 0) })
    for (const deadline = Date.now() + 30_000; settled < 400; await new Promise((resolve) => setTimeout(resolve, 10)))
      assert.ok(Date.now() < deadline, "the streaming host settled 400 flushes")
    const known = settled
    child.kill("SIGKILL")
    await new Promise((resolve) => child.once("exit", resolve))
    const blocks = reopened(folder, auditSnapshot(0).session.id)
    const answer = blocks[0]
    assert.ok(answer?.type === "text")
    const words = answer.text.trim().split(" ")
    assert.ok(words.length >= known, `${words.length} flushes were kept of the ${known} the host knew written`)
    assert.deepEqual(words, Array.from({ length: words.length }, (_, at) => WORD(at).trim()), "the flushes kept are every one from the first, in order")
    // A call's block came with its flush: none is there without the words before it.
    for (const block of blocks.slice(1)) assert.ok((block.type === "tool" || block.type === "user") && Number(block.id?.split("-")[1]) < words.length)
    // Each block and its line of the turn index went in one transaction: whatever the kill cut, the index says what a walk says.
    const kept = scans(folder, auditSnapshot(0).session.id)
    assert.ok(kept.indexed && kept.indexed.turns.length > 10, "the killed host's index is whole")
    assert.deepEqual(kept.indexed, kept.walked, "a host killed mid-stream leaves an index that equals a walk")
  }

  // The turn index: built once from a walk on a reader's thread, then kept by every commit, the writer's included,
  // through appends, a rewind, a block that stops being a turn's, and a base written; a commit by a build that knows
  // no index leaves it unused until it is built again.
  {
    const folder = join(root, "indexed")
    const writer = new JournalWriter(), readers = new JournalReaders()
    assert.ok(await writer.started())
    const first = streaming(folder, writer)
    for (let flush = 0; flush < 60; flush += 1) first.flush()
    first.end()
    await first.journal.close()
    assert.equal(scans(folder, first.id).indexed, undefined, "a journal no walk has indexed has no index to read")
    const walked = await readers.scan(join(folder, `${first.id}.sqlite`))
    assert.deepEqual(scans(folder, first.id).indexed, walked, "its first cold open walks it and leaves the index")
    assert.deepEqual(await readers.scan(join(folder, `${first.id}.sqlite`)), walked, "the next reads the index, and the same")
    const same = (after: string) => {
      const found = scans(folder, first.id)
      assert.ok(found.indexed, `the index is whole ${after}`)
      assert.deepEqual(found.indexed, found.walked, `the index says what a walk says ${after}`)
    }
    // A host takes the conversation up again: commits of its own, and a running turn's through the writer.
    const journal = new LiveJournal(folder, first.id)
    journal.writeWith(writer)
    let snapshot = journal.read()!
    const commit = (next: typeof snapshot) => { journal.commit(next, snapshot); snapshot = next }
    commit({ ...snapshot, revision: snapshot.revision + 1, session: { ...snapshot.session, status: "running" }, blocks: [...snapshot.blocks, { type: "user", id: "ask-2", text: "next", requestId: "request-next" }, { type: "text", id: "answer-2", text: "" }] })
    journal["settleWrites"]()
    same("after a turn's start")
    for (let word = 0; word < 40; word += 1) {
      const blocks = snapshot.blocks.map((block) => block.type === "text" && block.id === "answer-2" ? { ...block, text: block.text + WORD(word) } : block)
      if (word % 9 === 8) blocks.push({ type: "provider-turn", id: `own-${word}`, reason: "woke" })
      commit({ ...snapshot, revision: snapshot.revision + 1, blocks })
    }
    journal["settleWrites"]()
    same("after a stream through the writer")
    // A block that began a turn becomes one that doesn't, in place.
    commit({ ...snapshot, revision: snapshot.revision + 1, blocks: snapshot.blocks.map((block) => block.id === "own-8" ? { type: "text", id: "own-8", text: "not a turn" } : block) })
    journal["settleWrites"]()
    same("after a block changed kind")
    commit({ ...snapshot, revision: snapshot.revision + 1, session: { ...snapshot.session, status: "ready" } })
    same("after the turn's end")
    // A rewind: the blocks from the turn's prompt on are gone.
    commit({ ...snapshot, revision: snapshot.revision + 1, blocks: snapshot.blocks.slice(0, snapshot.blocks.findIndex((block) => block.id === "ask-2")) })
    same("after a rewind")
    await journal.close()
    same("after its close")
    // A build that knows no index commits: the revision moves in row 1 alone, and the index isn't read.
    const older = new DatabaseSync(join(folder, `${first.id}.sqlite`))
    older.prepare("INSERT OR REPLACE INTO blocks VALUES (?, ?)").run(snapshot.blocks.length, JSON.stringify({ type: "user", id: "older", text: "from an older build", requestId: "request-older" }))
    older.prepare("INSERT OR REPLACE INTO progress VALUES (1, ?)").run(snapshot.revision + 1)
    older.close()
    assert.equal(scans(folder, first.id).indexed, undefined, "a commit that kept no index leaves it unread")
    const again = await readers.scan(join(folder, `${first.id}.sqlite`))
    assert.equal(again.turns.at(-1)?.request, "request-older")
    same("after it was built again")
    await readers.stop()
    await writer.stop()
  }
  console.log("journal writer ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
