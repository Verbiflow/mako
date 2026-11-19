import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Entry } from "@mako/sessions/entries"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { buildTurnIndex, coldScan, LiveJournal } from "@mako/host/conversations/live-journal"
import { AgentsWorld } from "./agents-world.ts"

/*
 * What a host of many weeks holds besides worktrees, for `bench:host-load --scale person`: Apexes whose Fins have
 * finished, and conversations whose journals are long. A tree's start rate (48 in ten minutes, 120 in an hour) keeps
 * a real host from starting an Apex's 226 Fins within a run, so they are made here, before the host starts, by the
 * engine itself on scripted harnesses (`AgentsWorld`) in the host's own stores, and dated days back so the tree has
 * room for the Fins the run starts for real.
 */

const WORDS = "the host reads conversation again and keeps what it adds while history holds turns of tool output with paths and diffs over 42 lines".split(" ")

/** `chars` of prose that differs by `index`, as a transcript's text and a call's output do. */
function prose(index: number, chars: number): string {
  const parts: string[] = []
  let length = 0
  for (let at = index + 1; length < chars; at = (at * 1_103_515_245 + 12_345) % 2_147_483_648) {
    const word = WORDS[at % WORDS.length]!
    parts.push(word)
    length += word.length + 1
  }
  return parts.join(" ").slice(0, chars)
}

export interface SeededTree {
  /** The Apex's conversation, and the Session its tools speak for. */
  conversation: string
  session: string
  fins: number
}

export interface TreeSeed {
  /** Each Apex's finished Fins. */
  trees: readonly number[]
  /** Kilobytes of calls and text a Fin's one turn leaves in its journal, by its place in its tree. */
  kilobytes: (index: number) => number
  /** Reports each Fin kept before its last. */
  reports: number
  /** How long ago the trees were started. */
  agedMs: number
}

/** The seeded Apexes, each with its Fins finished and reported, in the stores under `dataRoot` as a host leaves them. */
export async function seedTrees(dataRoot: string, seed: TreeSeed): Promise<SeededTree[]> {
  const total = seed.trees.reduce((sum, count) => sum + count, 0)
  const world = new AgentsWorld({
    root: dataRoot,
    noRoomWatch: true,
    budget: { running: total + 10, started: total + 10, hourly: total + 10 },
    script: async (turn) => {
      const fin = /SEED-\d+-(\d+)/.exec(turn.text)
      if (!fin) return "ok"
      const chars = seed.kilobytes(Number(fin[1])) * 1024
      for (let written = 0, step = 0; written < chars; step += 1) {
        const output = prose(step, 6_000)
        turn.world.live.observe({ type: "live-update", id: turn.conversation, update: { kind: "tool", id: `call-${step}`, title: "Bash", name: "Bash", status: "completed", input: JSON.stringify({ command: `npm test -- part-${step}` }), output } })
        turn.world.live.observe({ type: "live-update", id: turn.conversation, update: { kind: "text", text: `${prose(step + 7, 500)}\n\n` } })
        written += 6_500
        // A frame's worth at a time, so each lands in the journal as a turn's did.
        if (step % 16 === 15) await new Promise((resolve) => setTimeout(resolve, 0))
      }
      await turn.world.agents.report(turn.caller, { status: "done", summary: `Part ${fin[1]} is finished; see https://github.com/acme/app/pull/${2000 + Number(fin[1])}.`, clientKey: "done" })
      return "Done."
    },
  })
  const seeded: SeededTree[] = []
  const children: string[] = []
  for (const [tree, count] of seed.trees.entries()) {
    const apex = await world.apex(tree % 2 ? "codex" : "claude", "full")
    for (let index = 0; index < count; index += 1) {
      const name = `part-${tree}-${index}`
      const started = await world.agents.start(apex.caller, { brief: { objective: `SEED-${tree}-${index} Label batch ${index}.` }, name, harness: index % 4 ? "claude" : "codex", cwd: dataRoot, clientKey: name, queue: true })
      if ("refused" in started || !started.child) throw new Error(`The seeded tree refused Fin ${name}: ${JSON.stringify(started)}`)
      children.push(started.child)
      // A few at a time: every Fin of a tree working at once is no day's work.
      if (index % 16 === 15) await world.settle(40, 300_000)
    }
    await world.settle(40, 300_000)
    if (apex.caller.kind !== "agent") throw new Error("The seeded Apex has no Session")
    seeded.push({ conversation: apex.conversation, session: apex.caller.session, fins: count })
  }
  for (const child of children)
    for (let index = 0; index < seed.reports; index += 1)
      world.store.keepReport({ id: `report:${child}:old-${index}`, child: ThreadIdSchema.parse(child), status: index % 3 ? "progress" : "done", summary: `Batch ${index}: labelled ${index * 7} rows; see https://github.com/acme/app/pull/${1000 + index}.`, ownerGeneration: 1, at: Date.now() - seed.agedMs - (seed.reports - index) * 60_000 })
  await world.settle(300, 300_000)
  await world.close()

  // The world keeps its journals beside the store; a host keeps them in `conversations`.
  const journals = join(dataRoot, "journals")
  const kept = join(dataRoot, "conversations")
  mkdirSync(kept, { recursive: true })
  for (const name of readdirSync(journals)) renameSync(join(journals, name), join(kept, name))
  rmSync(journals, { recursive: true, force: true })
  // Started days ago: a tree counts its starts of the last ten minutes and hour against the next one.
  const store = new DatabaseSync(join(dataRoot, "threads.sqlite"))
  try {
    store.exec("PRAGMA busy_timeout=5000")
    // The engine reads an edge's time from its record; the column only orders them.
    store.prepare("UPDATE thread_parents SET created_at = created_at - ?, record = json_set(record, '$.createdAt', json_extract(record, '$.createdAt') - ?)").run(seed.agedMs, seed.agedMs)
    store.prepare("UPDATE agent_spawns SET at = at - ?").run(seed.agedMs)
  } finally { store.close() }
  return seeded
}

/** A turn as a long agent session has them: a prompt, thinking, calls whose output is most of the bytes, replies. */
const TURN = ["user", "thinking", "tool", "text", "thinking", "tool", "tool", "text"] as const
const OUTPUT_CHARS = 9_000

function requestIdOf(turn: number): string {
  return `00000000-0000-4000-8000-${turn.toString(16).padStart(12, "0")}`
}

function block(index: number): Entry {
  const kind = TURN[index % TURN.length]!
  const id = `entry-${index}`
  if (kind === "user") return { type: "user", id, text: `Ask ${index}: ${prose(index, 300)}`, requestId: requestIdOf(Math.floor(index / TURN.length)) }
  if (kind === "thinking") return { type: "thinking", id, text: prose(index, 500) }
  if (kind === "text") return { type: "text", id, text: prose(index, 600) }
  return { type: "tool", id: `call-${index}`, name: "Bash", status: "completed", input: JSON.stringify({ command: `ls ${index}` }), output: prose(index, OUTPUT_CHARS) }
}

export interface LongJournal {
  conversation: string
  /** The Claude Code session its Thread was bound to, and that session's file. */
  session: string
  path: string
  cwd: string
  megabytes: number
}

/**
 * A resting conversation's journal of about `megabytes` of Mako's own blocks, none of them in its session's record,
 * as a host left it: what a window opening a long conversation has the host read. Returns the file's bytes.
 */
export async function writeLongJournal(dataRoot: string, long: LongJournal): Promise<number> {
  const perEntry = TURN.reduce((sum, kind) => sum + (kind === "tool" ? OUTPUT_CHARS : kind === "user" ? 310 : kind === "text" ? 600 : 500), 0) / TURN.length
  const entries = Math.max(TURN.length, Math.round((long.megabytes * 1_048_576) / perEntry / TURN.length) * TURN.length)
  const blocks: Entry[] = []
  for (let index = 0; index < entries; index += 1) blocks.push(block(index))
  const requests: LiveSnapshot["requests"] = Array.from({ length: entries / TURN.length }, (_, turn) => ({
    id: requestIdOf(turn), text: `Ask ${turn * TURN.length}`, attachments: [], status: "completed", createdAt: 1,
  }))
  const id = long.conversation
  const snapshot: LiveSnapshot = {
    session: { id, harness: "claude", nativeId: long.session, nativePath: long.path, cwd: long.cwd, title: `A long conversation (${long.megabytes} MB)`, status: "ready", connection: "disconnected", modes: [], currentMode: null, configOptions: [] },
    revision: 1, createdAt: Date.now() - 86_400_000, threadPath: long.path, base: null,
    blocks, permissions: [], requests,
    control: { merges: [], activeBindingId: id, transfers: [], bindings: [{ id, provider: "claude", nativeId: long.session, path: long.path, coveredBlocks: 0, includesBase: false }] },
  }
  const root = join(dataRoot, "conversations")
  mkdirSync(root, { recursive: true })
  const journal = new LiveJournal(root, id)
  journal.commit(snapshot)
  await journal.close()
  // Its turn index is whole, as a journal's is once it has been opened cold: the run's open reads it, and no walk.
  const db = new DatabaseSync(join(root, `${id}.sqlite`))
  try {
    buildTurnIndex(db, coldScan(db))
  } finally { db.close() }
  return statSync(join(root, `${id}.sqlite`)).size
}
