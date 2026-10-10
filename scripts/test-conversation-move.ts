import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { moveIntoWorktree, type ConversationMoveDeps } from "../electron/conversation-move.ts"
import type { ForkInput } from "../electron/contracts/conversation-control.ts"
import type { LiveSnapshot } from "../electron/contracts/live-conversations.ts"

/**
 * A conversation moving into its Thread's worktree: the same session when its
 * harness goes on there, proved by resuming it once the worktree is the
 * Thread's; a fork with its transcript when it can't, or when that resume
 * fails, into the same worktree, with the changes moved once and the
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
    control: { activeBindingId: id, bindings: [], transfers: [], children: [], merges: [], actions: [] },
  }
}

function world(options: { relocatable: boolean; relocates?: boolean; refuses?: string }) {
  const calls: Calls = []
  const id = randomUUID()
  const conversations = new Map<string, LiveSnapshot>([[id, snapshot(id, join(project, "app"))]])
  let attached = false
  const owners = new Set<string>()
  const deps: ConversationMoveDeps = {
    conversations: {
      snapshot: (target) => conversations.get(target) ?? null,
      relocatable: () => options.relocatable,
      relocate: async (target, cwd) => {
        calls.push(`relocate ${cwd}`)
        if (options.relocates === false) return undefined
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
        return { cwd: worktree, path: worktree, branch: "mako/fixture", copied: 0, tookMs: 0, spare: false }
      },
      moveChanges: async () => { calls.push("move changes"); return 2 },
      attach: async () => { calls.push("attach"); attached = true },
      abandon: async (owner) => { calls.push("abandon"); owners.delete(owner) },
    },
    warn: (_message, facts) => calls.push(`warn ${facts.reason}`),
  }
  const input: ForkInput = { id: randomUUID(), provider: "fixture", point: { kind: "run", requestId: "answer" }, thread: "parent", worktree: true, move: true }
  return { id, input, deps, calls, conversation: (target: string) => conversations.get(target)! }
}

try {
  const resumes = world({ relocatable: true })
  const moved = await moveIntoWorktree(resumes.deps, resumes.id, resumes.input, project)
  assert.equal(moved.relocated, true)
  assert.equal(moved.conversation.session.id, resumes.id, "the same conversation goes on")
  assert.equal(moved.conversation.session.cwd, join(worktree, "app"), "in the same folder inside the worktree")
  assert.equal(moved.moved, 2)
  assert.deepEqual(resumes.calls, ["prepare self", `relocate ${join(worktree, "app")}`, "move changes", "attach", "resume"],
    "the session resumes once the worktree is the Thread's, so it starts with the worktree's environment")

  const refused = world({ relocatable: true, refuses: "Path not found" })
  const forked = await moveIntoWorktree(refused.deps, refused.id, refused.input, project)
  assert.equal(forked.relocated, false)
  assert.equal(forked.refused, "Path not found", "the caller learns why")
  assert.equal(forked.conversation.session.id, refused.input.id, "a fork goes on")
  assert.equal(forked.conversation.session.cwd, join(worktree, "app"), "in the same worktree")
  assert.equal(forked.moved, 2, "the changes came along once")
  assert.equal(refused.conversation(refused.id).session.cwd, join(project, "app"), "the conversation stays as it was in its own folder")
  assert.deepEqual(refused.calls, ["prepare self", `relocate ${join(worktree, "app")}`, "move changes", "attach", "resume", "warn Path not found", `fork ${join(worktree, "app")}`],
    "one worktree, joined by the fork; nothing taken back")

  const undeclared = world({ relocatable: false })
  const plain = await moveIntoWorktree(undeclared.deps, undeclared.id, undeclared.input, project)
  assert.equal(plain.relocated, false)
  assert.equal(plain.refused, undefined)
  assert.deepEqual(undeclared.calls, ["prepare fork", `fork ${join(worktree, "app")}`, "move changes", "attach"], "a harness that can't go on elsewhere forks as before")

  const slipped = world({ relocatable: true, relocates: false })
  const late = await moveIntoWorktree(slipped.deps, slipped.id, slipped.input, project)
  assert.equal(late.relocated, false)
  assert.deepEqual(slipped.calls, ["prepare self", `relocate ${join(worktree, "app")}`, "abandon", "prepare fork", `fork ${join(worktree, "app")}`, "move changes", "attach"],
    "a conversation that got busy before it moved gives its worktree back and forks")

  const earlier = world({ relocatable: true })
  const fromEarlier = await moveIntoWorktree(earlier.deps, earlier.id, { ...earlier.input, point: { kind: "run", requestId: "an earlier answer" } }, project)
  assert.equal(fromEarlier.relocated, false, "a move from an earlier answer forks there")
  const copy = world({ relocatable: true })
  assert.equal((await moveIntoWorktree(copy.deps, copy.id, { ...copy.input, move: false }, project)).relocated, false, "a fork into the worktree that isn't a move leaves the conversation where it is")
  console.log("Conversation move: the same session when it resumes in the worktree, proved once the worktree is the Thread's; otherwise, or when that resume fails, a fork into the same worktree, changes moved once")
} finally {
  rmSync(root, { recursive: true, force: true })
}
