import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "../electron/live-conversations.ts"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import type { ProviderLiveDriver, ProviderStartOptions } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

/**
 * A conversation moves to another folder under its own native session when
 * its harness declares it goes on there: the provider sleeps, the folder
 * changes, and the next message resumes the same session in the new folder.
 * Mid-turn, or while Mako still checkpoints the turn that ended, it waits;
 * without the declaration nothing changes and the caller forks.
 */

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) await delay(5)
  assert.ok(check(), "Expected lifecycle transition")
}

const root = mkdtempSync(join(tmpdir(), "mako-conversation-relocate-"))
const main = join(root, "main")
const worktree = join(root, "worktree")
mkdirSync(main)
mkdirSync(worktree)

/** Snapshots whose end-of-turn checkpoint waits until `release`, as a large workspace's does. */
class HeldSnapshots extends WorkspaceSnapshots {
  private held = Promise.withResolvers<void>()
  release(): void { this.held.resolve() }
  override async endRun(requestId: string) {
    await this.held.promise
    return super.endRun(requestId)
  }
}

function fixture(provider: string, elsewhere: boolean, refuses?: string, projectFolderOfRemoved?: (cwd: string) => string | undefined, workspaceSnapshots?: WorkspaceSnapshots) {
  const settled: string[] = []
  const starts: { cwd: string; options: ProviderStartOptions }[] = []
  let closes = 0
  let owner: LiveConversations | undefined
  let running = false
  const state = (cwd: string, id: string): LiveSessionState => ({ id, nativeId: `native-${provider}`, nativePath: join(root, `${provider}.jsonl`), harness: provider, cwd, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] })
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    resume: fixtureResume(elsewhere ? { elsewhere: { via: "fixture", verified: "fixture" } } : {}),
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider, available: () => true,
    start: async (cwd, options) => {
      starts.push({ cwd, options })
      if (cwd === refuses && options.resume) throw new Error(`Path not found: ${cwd}`)
      return state(cwd, options.conversationId)
    },
    prompt: async (id) => {
      const cwd = starts.at(-1)!.cwd
      owner!.observe({ type: "live-session", session: { ...state(cwd, id), status: "running" } })
      if (!running) owner!.observe({ type: "live-session", session: state(cwd, id) })
    },
    permission: async () => {}, cancel: async () => {}, setMode: async () => {},
    close: async () => { closes += 1 },
  }
  owner = new LiveConversations({
    root: join(root, `journals-${provider}`), appPath: root, driver: () => driver,
    history: async () => null, emit() {}, providerIdleMs: 60_000, providerWarmLimit: 10,
    checkpoint: async () => "checkpoint",
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
    projectFolderOfRemoved, workspaceSnapshots,
    settled: (id) => settled.push(id),
  })
  return { owner, starts, settled, closes: () => closes, hold: (value: boolean) => { running = value } }
}

const owners: LiveConversations[] = []
try {
  const moving = fixture("goes-elsewhere", true)
  owners.push(moving.owner)
  const id = randomUUID()
  await moving.owner.start("goes-elsewhere", main, { conversationId: id })
  moving.hold(true)
  moving.owner.submit(id, randomUUID(), "a turn still running")
  await until(() => moving.owner.snapshot(id)?.session.status === "running")
  assert.deepEqual(moving.owner.relocation(id), { kind: "wait", reason: "is running a turn" }, "a running turn doesn't move yet")
  assert.equal(await moving.owner.relocate(id, worktree), undefined)
  moving.owner.observe({ type: "live-session", session: { ...moving.owner.session(id)!, status: "ready" } })
  moving.hold(false)
  await until(() => moving.owner.snapshot(id)?.requests[0]?.status === "completed" && moving.owner.lifecycleWork().length === 0)
  await delay(10)

  assert.deepEqual(moving.owner.relocation(id), { kind: "now" })
  assert.equal(await moving.owner.relocate(id, worktree), main, "it returns the folder it left")
  assert.equal(moving.closes(), 1, "the provider sleeps before the folder changes")
  assert.equal(moving.owner.session(id)?.cwd, worktree)
  assert.equal(moving.owner.session(id)?.connection, "hibernated")
  assert.equal(await moving.owner.relocate(id, worktree), worktree, "moving it again where it is changes nothing")
  assert.equal(moving.closes(), 1)

  assert.equal(await moving.owner.resumeMoved(id, main), undefined, "the move is proved before anyone writes")
  const woke = moving.starts.at(-1)!
  assert.equal(moving.starts.length, 2)
  assert.equal(woke.cwd, worktree, "the session resumes in the new folder")
  assert.equal(woke.options.resume, "native-goes-elsewhere", "under the same native session")
  assert.equal(woke.options.conversationId, moving.owner.snapshot(id)?.control?.activeBindingId)
  assert.equal(moving.owner.session(id)?.connection, "connected")
  assert.equal(moving.owner.snapshot(id)?.requests.length, 1, "proving it sends nothing")
  moving.owner.submit(id, randomUUID(), "the next message")
  await until(() => moving.owner.snapshot(id)?.requests[1]?.status === "completed")
  assert.equal(moving.starts.length, 2, "the next message goes to the session already resumed there")

  const refusing = fixture("refuses-elsewhere", true, worktree)
  owners.push(refusing.owner)
  const refused = randomUUID()
  await refusing.owner.start("refuses-elsewhere", main, { conversationId: refused })
  refusing.owner.submit(refused, randomUUID(), "seed")
  await until(() => refusing.owner.snapshot(refused)?.requests[0]?.status === "completed" && refusing.owner.lifecycleWork().length === 0)
  await delay(10)
  assert.equal(await refusing.owner.relocate(refused, worktree), main)
  assert.match(await refusing.owner.resumeMoved(refused, main) ?? "", /Path not found/, "a harness that no longer goes on there is found out during the move")
  const restored = refusing.owner.session(refused)!
  assert.deepEqual([restored.cwd, restored.connection, restored.status, restored.error], [main, "hibernated", "ready", undefined], "it goes back to its own folder, asleep as it was")
  assert.equal(refusing.owner.snapshot(refused)?.requests.every((request) => request.status === "completed"), true, "no request fails with it")
  refusing.owner.submit(refused, randomUUID(), "still usable where it was")
  await until(() => refusing.owner.snapshot(refused)?.requests[1]?.status === "completed")
  assert.equal(refusing.starts.at(-1)!.cwd, main, "and resumes in its own folder")

  const staying = fixture("stays-put", false)
  owners.push(staying.owner)
  const other = randomUUID()
  await staying.owner.start("stays-put", main, { conversationId: other })
  staying.owner.submit(other, randomUUID(), "seed")
  await until(() => staying.owner.snapshot(other)?.requests[0]?.status === "completed" && staying.owner.lifecycleWork().length === 0)
  assert.equal(staying.owner.relocation(other).kind, "never", "a harness that doesn't declare it forks instead")
  assert.equal(await staying.owner.relocate(other, worktree), undefined)
  assert.equal(staying.owner.session(other)?.cwd, main)
  assert.equal(staying.owner.session(other)?.connection, "connected")
  assert.equal(staying.closes(), 0)

  // The move is asked for as the turn ends, while Mako still checkpoints the workspace.
  const held = new HeldSnapshots(join(root, "held-snapshots"))
  const finishing = fixture("finishing", true, undefined, undefined, held)
  owners.push(finishing.owner)
  const ending = randomUUID()
  await finishing.owner.start("finishing", main, { conversationId: ending })
  finishing.owner.submit(ending, randomUUID(), "a turn whose checkpoint is slow")
  await until(() => finishing.owner.snapshot(ending)?.requests[0]?.status === "completed")
  assert.deepEqual(finishing.owner.relocation(ending), { kind: "wait", reason: "is saving or rewinding its workspace" }, "the turn ended but its checkpoint hasn't")
  assert.equal(await finishing.owner.relocate(ending, worktree), undefined, "so it doesn't move yet")
  const waited = finishing.owner.relocationWithin(ending, 5000)
  const told = finishing.settled.length
  held.release()
  assert.deepEqual(await waited, { kind: "now" }, "a move waiting on it goes ahead once the checkpoint lands")
  assert.ok(finishing.settled.length > told && finishing.settled.every((settled) => settled === ending), "and the host hears the conversation settled, so an agent's move can go")
  assert.deepEqual(await finishing.owner.relocationWithin(ending, 0), { kind: "now" })
  const slow = fixture("finishing-slowly", true, undefined, undefined, new HeldSnapshots(join(root, "never-released")))
  owners.push(slow.owner)
  const stuck = randomUUID()
  await slow.owner.start("finishing-slowly", main, { conversationId: stuck })
  slow.owner.submit(stuck, randomUUID(), "a checkpoint that never lands")
  await until(() => slow.owner.snapshot(stuck)?.requests[0]?.status === "completed")
  assert.deepEqual(await slow.owner.relocationWithin(stuck, 50), { kind: "wait", reason: "is saving or rewinding its workspace" }, "a wait that runs out says what it waited on")

  // The Thread's worktree is merged and removed while its conversation sleeps there.
  const removedTree = join(root, "removed-worktree")
  mkdirSync(removedTree)
  const returning = fixture("returns", true, undefined, (cwd) => cwd === removedTree && !existsSync(cwd) ? main : undefined)
  owners.push(returning.owner)
  const back = randomUUID()
  await returning.owner.start("returns", removedTree, { conversationId: back })
  returning.owner.submit(back, randomUUID(), "work in the worktree")
  await until(() => returning.owner.snapshot(back)?.requests[0]?.status === "completed" && returning.owner.lifecycleWork().length === 0)
  await delay(10)
  assert.equal(returning.owner.hibernateIfIdle(back), true)
  await until(() => returning.owner.session(back)?.connection === "hibernated")
  rmSync(removedTree, { recursive: true })
  returning.owner.submit(back, randomUUID(), "after the merge")
  await until(() => returning.owner.snapshot(back)?.requests[1]?.status === "completed")
  assert.equal(returning.starts.at(-1)!.cwd, main, "it goes on in the project folder the worktree was made from")
  assert.equal(returning.starts.at(-1)!.options.resume, "native-returns", "under the same native session")
  assert.equal(returning.owner.session(back)?.cwd, main)

  const leftTree = join(root, "left-worktree")
  mkdirSync(leftTree)
  const left = fixture("stays-in-removed", false, undefined, (cwd) => cwd === leftTree && !existsSync(cwd) ? main : undefined)
  owners.push(left.owner)
  const kept = randomUUID()
  await left.owner.start("stays-in-removed", leftTree, { conversationId: kept })
  left.owner.submit(kept, randomUUID(), "work in the worktree")
  await until(() => left.owner.snapshot(kept)?.requests[0]?.status === "completed" && left.owner.lifecycleWork().length === 0)
  await delay(10)
  assert.equal(left.owner.hibernateIfIdle(kept), true)
  await until(() => left.owner.session(kept)?.connection === "hibernated")
  rmSync(leftTree, { recursive: true })
  left.owner.submit(kept, randomUUID(), "after the merge")
  await until(() => left.starts.length === 2)
  assert.equal(left.starts.at(-1)!.cwd, leftTree, "a harness that can't resume elsewhere isn't moved under its native session")
  console.log("Conversation relocate: an idle session sleeps, moves and is resumed in the new folder under its native ID before anyone writes; one that doesn't resume goes back to its folder, asleep and usable; mid-turn or mid-checkpoint it waits, then goes; undeclared, nothing changes; one whose worktree was removed goes on in the project folder")
} finally {
  for (const owner of owners) await owner.stop()
  rmSync(root, { recursive: true, force: true })
}
