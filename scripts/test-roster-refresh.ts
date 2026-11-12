import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ActorSchema, SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * A Fin's roster entry is kept until something it shows moves (`Agents.sync`, `npm run test:roster-refresh`): a commit
 * that changed nothing of it keeps the entry, a rename of its Thread or a journal added to its Session reads it again at
 * once, with no batch of its own, so the roster and the Inbox never show an idle Fin's old title. A title log pruned
 * past what was read rebuilds every entry.
 */
const root = mkdtempSync(join(tmpdir(), "mako-roster-refresh-"))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(5)
  }
}

const world = new AgentsWorld({ root, script: (turn) => (turn.text.includes("You're fin:") ? "Labelled." : "ok") })
try {
  const apex = await world.apex("claude", "full")
  const started = (name: string) => world.agents.start(apex.caller, { brief: { objective: `Label ${name}` }, name, harness: "claude", cwd: world.root, clientKey: name })
  const one = await started("labels")
  const other = await started("sorter")
  assert.ok(!("refused" in one) && !("refused" in other))
  await until("both Fins' first turns", () => world.prompts.filter((prompt) => prompt.text.includes("You're fin:")).length === 2)
  await world.settle(40, 20_000)
  const entry = (child: string) => world.agents.roster(apex.conversation).find((agent) => agent.child?.thread === child)!
  const fin = one.child!
  const before = entry(fin)
  assert.ok(before, "the Fin is in its Apex's roster")
  const actor = ActorSchema.parse({ kind: "agent", session: world.store.journalPlacement(apex.conversation)!.session })

  // Another Thread renamed: a commit, and nothing this Fin shows moved, so its entry is the one held.
  world.store.renameThread({ operationId: randomUUID(), thread: ThreadIdSchema.parse(other.child!), title: "Sorter, renamed", actor })
  assert.equal(entry(fin), before, "a commit that changed nothing of a Fin keeps its entry")
  assert.equal(entry(other.child!).title, "Sorter, renamed", "the renamed one shows its new title")

  // The idle Fin renamed: shown at once, with no batch of its own.
  const prompts = world.prompts.length
  world.store.renameThread({ operationId: randomUUID(), thread: ThreadIdSchema.parse(fin), title: "Labels, renamed", actor })
  assert.equal(entry(fin).title, "Labels, renamed", "a renamed idle Fin shows its new title in its Apex's roster")
  assert.equal(world.prompts.length, prompts, "and nothing ran for it")

  // Another Mako's rename, through its own connection: heard the same way.
  const foreign = new DatabaseSync(join(root, "threads.sqlite"))
  foreign.exec("PRAGMA busy_timeout=5000")
  foreign.prepare("UPDATE threads SET title = ? WHERE id = ?").run("Labels, from another Mako", fin)
  assert.equal(entry(fin).title, "Labels, from another Mako", "another Mako's rename shows too")

  // Title changes pruned past what was read: every entry is read again.
  const sorter = entry(other.child!)
  foreign.exec("DELETE FROM title_changes")
  foreign.prepare("INSERT INTO title_changes (seq, thread_id) VALUES (?, ?)").run(1_000_000, other.child!)
  foreign.close()
  assert.notEqual(entry(other.child!), sorter, "a pruned log rebuilds every entry")
  // A journal added to its Session: its entry is read again (last: the journal here is a stand-in with no conversation behind it).
  const held = entry(fin)
  const session = world.store.thread(ThreadIdSchema.parse(fin))!.sessions[0]!
  world.store.registerJournal({ conversationId: randomUUID(), createdAt: Date.now(), harness: "claude", bindings: [], session: SessionIdSchema.parse(session) }, actor)
  assert.notEqual(entry(fin), held, "a journal added to a Fin's Session reads its entry again")

  console.log("roster refresh: a rename, a journal and another Mako's rename reach an idle Fin's entry; other commits keep it")
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
