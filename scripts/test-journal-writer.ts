import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { JournalWriter } from "@mako/host/conversations/journal-writer"
import { JournalWriteError, LiveJournal } from "@mako/host/conversations/live-journal"
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
  const turn = streaming(process.argv[3]!, writer)
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

  // Closed with writes still waiting, and the writer stopped right after: a new host reads every flush.
  {
    const writer = new JournalWriter()
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
    const turn = streaming(join(root, "stopped"), writer)
    for (let flush = 0; flush < 50; flush += 1) turn.flush()
    await writer.stop()
    for (let flush = 0; flush < 50; flush += 1) turn.flush()
    turn.end()
    assert.deepEqual(turn.journal.read()?.blocks, turn.snapshot().blocks)
    await turn.journal.close()
    assert.deepEqual(reopened(join(root, "stopped"), turn.id), turn.snapshot().blocks, "a journal whose writer is gone writes what it was given itself")
  }

  // A write that fails on the writer (a row it can't insert): the journal writes each block whole from memory and
  // goes on writing its own. One the journal can't make good either is a commit that failed, as it always was.
  {
    const writer = new JournalWriter()
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
    for (const block of blocks.slice(1)) assert.ok(block.type === "tool" && Number(block.id?.slice(5)) < words.length)
  }
  console.log("journal writer ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
