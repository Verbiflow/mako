import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { moveIntoWorktree, type ConversationMoveDeps } from "@mako/host/workspaces/conversation-move"
import type { ForkInput } from "@mako/host/contracts/conversation-control"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { Relocation } from "@mako/host/workspaces/conversations"
import type { MoveOutcome } from "@mako/host/contracts/workspace-moves"

/** A move's outcome that took `files` and left nothing behind. */
const cameAlong = (files: number): MoveOutcome => {
  const none = { files: 0, lines: 0, paths: [] }
  return { came: { files, lines: 0, paths: [] }, stayed: { others: none, person: none, uncertain: none, unattributed: none }, split: [], brought: false, unstaged: [] }
}

/**
 * A conversation moving into its Thread's worktree: the same session when its
 * harness goes on there, proved by resuming it once the worktree is the
 * Thread's; a refusal while it is still finishing something; a fork with
 * its transcript when it can't, or when that resume fails, into the same worktree, with the changes moved once and the
 * conversation left as it was.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-conversation-move-")))
const project = join(root, "project")
const worktree = join(root, "worktree")
for (const folder of [join(project, "app"), join(worktree, "app")]) mkdirSync(folder, { recursive: true })

type Calls = string[]

function snapshot(id: string, cwd: string): LiveSnapshot {
  return {
    session: { id, harness: "fixture", cwd, title: "Fixture", status: "ready", connection: "hibernated", modes: [], currentMode: null, configOptions: [] },
    revision: 1, createdAt: 1, blocks: [], base: null, permissions: [],
    requests: [{ id: "answer", text: "seed", attachments: [], status: "completed" }],
    control: { activeBindingId: id, bindings: [], transfers: [], merges: [], actions: [] },
  }
}

const now: Relocation = { kind: "now" }

function world(options: { relocation: Relocation; relocates?: boolean; refuses?: string; busyFor?: number; turnMs?: number }) {
  const calls: Calls = []
  const id = randomUUID()
  const conversations = new Map<string, LiveSnapshot>([[id, snapshot(id, join(project, "app"))]])
  let attached = false
  // Turns the conversation began while its worktree was made, each ending as the move waits on it.
  let busy = 0
  const owners = new Set<string>()
  const deps: ConversationMoveDeps = {
    conversations: {
      snapshot: (target) => conversations.get(target) ?? null,
      relocation: () => busy > 0 ? { kind: "wait", reason: "is running a turn" } : options.relocation,
      relocationWithin: async () => {
        if (busy > 0) {
          // Each turn takes `turnMs` to end: a move waiting on it waits that long.
          if (options.turnMs) await new Promise((resolve) => setTimeout(resolve, options.turnMs))
          calls.push("turn ends")
          busy -= 1
        }
        return options.relocation
      },
      relocate: async (target, cwd) => {
        calls.push(`relocate ${cwd}`)
        if (options.relocates === false || busy > 0) return undefined
        const current = conversations.get(target)!
        conversations.set(target, snapshot(target, cwd))
        return current.session.cwd
      },
      resumeMoved: async (target, from) => {
        calls.push("resume")
        if (!options.refuses) return undefined
        conversations.set(target, snapshot(target, from))
        return options.refuses
      },
      historyReady: async () => {},
      fork: (source, input, cwd) => {
        calls.push(`fork ${cwd}`)
        const forked = snapshot(input.id, cwd ?? conversations.get(source)!.session.cwd)
        conversations.set(input.id, forked)
        return forked
      },
    },
    worktrees: {
      joinFolder: async (_source, owner) => owners.has(owner) || !attached ? undefined : join(worktree, "app"),
      prepareFork: async (_source, owner) => {
        calls.push(`prepare ${owner === id ? "self" : "fork"}`)
        owners.add(owner)
        if (owner === id) busy = options.busyFor ?? 0
        return { cwd: worktree, path: worktree, branch: "mako/fixture", copied: 0, tookMs: 0, spare: false }
      },
      moveChanges: async () => { calls.push("move changes"); return cameAlong(2) },
      attach: async () => { calls.push("attach"); attached = true },
      abandon: async (owner) => { calls.push("abandon"); owners.delete(owner) },
    },
    warn: (_message, facts) => calls.push(`warn ${facts.reason}`),
  }
  const input: ForkInput = { id: randomUUID(), provider: "fixture", point: { kind: "run", requestId: "answer" }, thread: "parent", worktree: true, move: true }
  return { id, input, deps, calls, conversation: (target: string) => conversations.get(target)! }
}

try {
  const resumes = world({ relocation: now })
  const moved = await moveIntoWorktree(resumes.deps, resumes.id, resumes.input, project)
  assert.equal(moved.relocated, true)
  assert.equal(moved.conversation.session.id, resumes.id, "the same conversation goes on")
  assert.equal(moved.conversation.session.cwd, join(worktree, "app"), "in the same folder inside the worktree")
  assert.equal(moved.moved, 2)
  assert.deepEqual(resumes.calls, ["prepare self", `relocate ${join(worktree, "app")}`, "move changes", "attach", "resume"],
    "the session resumes once the worktree is the Thread's, so it starts with the worktree's environment")

  const refused = world({ relocation: now, refuses: "Path not found" })
  const forked = await moveIntoWorktree(refused.deps, refused.id, refused.input, project)
  assert.equal(forked.relocated, false)
  assert.equal(forked.refused, "Path not found", "the caller learns why")
  assert.equal(forked.conversation.session.id, refused.input.id, "a fork goes on")
  assert.equal(forked.conversation.session.cwd, join(worktree, "app"), "in the same worktree")
  assert.equal(forked.moved, 2, "the changes came along once")
  assert.equal(refused.conversation(refused.id).session.cwd, join(project, "app"), "the conversation stays as it was in its own folder")
  assert.deepEqual(refused.calls, ["prepare self", `relocate ${join(worktree, "app")}`, "move changes", "attach", "resume", "warn Path not found", `fork ${join(worktree, "app")}`],
    "one worktree, joined by the fork; nothing taken back")

  const undeclared = world({ relocation: { kind: "never", reason: "runs on fixture, which doesn't resume a session in another folder" } })
  const plain = await moveIntoWorktree(undeclared.deps, undeclared.id, undeclared.input, project)
  assert.equal(plain.relocated, false)
  assert.equal(plain.refused, undefined)
  assert.deepEqual(undeclared.calls, ["warn runs on fixture, which doesn't resume a session in another folder", "prepare fork", `fork ${join(worktree, "app")}`, "move changes", "attach"],
    "a harness that can't go on elsewhere forks as before, and says why")

  const finishing = world({ relocation: { kind: "wait", reason: "has background tasks running" } })
  await assert.rejects(moveIntoWorktree(finishing.deps, finishing.id, finishing.input, project), /has background tasks running, so it can't move onto its own branch yet/,
    "a session still finishing something refuses the move rather than forking")
  assert.deepEqual(finishing.calls, [], "and nothing was made or moved")

  const slipped = world({ relocation: now, relocates: false })
  const late = await moveIntoWorktree(slipped.deps, slipped.id, slipped.input, project)
  assert.equal(late.relocated, false)
  assert.deepEqual(slipped.calls, ["prepare self", `relocate ${join(worktree, "app")}`, "abandon", "warn busy before it moved", "prepare fork", `fork ${join(worktree, "app")}`, "move changes", "attach"],
    "a conversation that can't go as itself, and isn't waiting on a turn, gives its worktree back and forks")

  const turning = world({ relocation: now, busyFor: 2 })
  const waited = await moveIntoWorktree(turning.deps, turning.id, turning.input, project, false, undefined, true)
  assert.equal(waited.relocated, true, "a conversation whose turns began while its worktree was made moves as itself once they end")
  assert.equal(waited.conversation.session.id, turning.id)
  assert.deepEqual(turning.calls, ["prepare self", `relocate ${join(worktree, "app")}`, "turn ends", `relocate ${join(worktree, "app")}`, "turn ends", `relocate ${join(worktree, "app")}`, "move changes", "attach", "resume"],
    "its worktree, and the branch its agent asked for, are kept for it: nothing given back, nothing forked")

  // The person's own move, from the composer, with a turn begun while its worktree was made that runs an hour: it
  // forks at once, as it always did, rather than holding the Thread "already moving" until the turn ends.
  const asked = world({ relocation: now, busyFor: 1, turnMs: 60 * 60_000 })
  const began = Date.now()
  const prompt = await moveIntoWorktree(asked.deps, asked.id, asked.input, project)
  assert.ok(Date.now() - began < 2_000, `the person's move ends within seconds, not after the turn: ${Date.now() - began} ms`)
  assert.equal(prompt.relocated, false)
  assert.deepEqual(asked.calls.slice(0, 5), ["prepare self", `relocate ${join(worktree, "app")}`, "abandon", "warn busy before it moved", "prepare fork"], "it gives the worktree back and forks, waiting on nothing")

  // A move made as its Mac goes off waits for nothing past its deadline: it forks as before.
  const hasty = world({ relocation: now, busyFor: 2 })
  const hurried = await moveIntoWorktree(hasty.deps, hasty.id, hasty.input, project, false, { by: Date.now() - 1 }, true)
  assert.equal(hurried.relocated, false, "a move in haste doesn't wait out a turn past its deadline")
  assert.deepEqual(hasty.calls.slice(0, 4), ["prepare self", `relocate ${join(worktree, "app")}`, "abandon", "warn busy before it moved"])

  const earlier = world({ relocation: now })
  const fromEarlier = await moveIntoWorktree(earlier.deps, earlier.id, { ...earlier.input, point: { kind: "run", requestId: "an earlier answer" } }, project)
  assert.equal(fromEarlier.relocated, false, "a move from an earlier answer forks there")
  const copy = world({ relocation: now })
  assert.equal((await moveIntoWorktree(copy.deps, copy.id, { ...copy.input, move: false }, project)).relocated, false, "a fork into the worktree that isn't a move leaves the conversation where it is")
  console.log("Conversation move: the same session when it resumes in the worktree, proved once the worktree is the Thread's; otherwise, or when that resume fails, a fork into the same worktree, changes moved once")
} finally {
  rmSync(root, { recursive: true, force: true })
}
