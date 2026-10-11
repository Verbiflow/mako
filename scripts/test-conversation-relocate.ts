import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import type { ProviderLiveDriver, ProviderStartOptions } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const gitRunner = new Git()

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
      if (!existsSync(cwd)) throw new Error(`The folder ${cwd} no longer exists. Open this in a folder that exists.`)
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
  const held = new HeldSnapshots(gitRunner, join(root, "held-snapshots"))
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
  const slow = fixture("finishing-slowly", true, undefined, undefined, new HeldSnapshots(gitRunner, join(root, "never-released")))
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

  // The worktree is removed outside Mako while its provider is still connected there.
  const goneTree = join(root, "gone-worktree")
  mkdirSync(goneTree)
  const stranded = fixture("stranded", true, undefined, (cwd) => cwd === goneTree && !existsSync(cwd) ? main : undefined, new WorkspaceSnapshots(gitRunner, join(root, "stranded-snapshots")))
  owners.push(stranded.owner)
  const live = randomUUID()
  await stranded.owner.start("stranded", goneTree, { conversationId: live })
  stranded.owner.submit(live, randomUUID(), "work in the worktree")
  await until(() => stranded.owner.snapshot(live)?.requests[0]?.status === "completed" && stranded.owner.lifecycleWork().length === 0)
  await delay(10)
  rmSync(goneTree, { recursive: true })
  stranded.owner.submit(live, randomUUID(), "after it was removed")
  await until(() => ["completed", "failed"].includes(stranded.owner.snapshot(live)?.requests[1]?.status ?? ""))
  assert.equal(stranded.owner.snapshot(live)?.requests[1]?.error, undefined, "the message isn't lost to the missing folder")
  assert.equal(stranded.owner.snapshot(live)?.requests[1]?.status, "completed")
  assert.equal(stranded.closes(), 1, "the provider in the removed folder sleeps")
  assert.deepEqual([stranded.starts.at(-1)!.cwd, stranded.starts.at(-1)!.options.resume], [main, "native-stranded"], "and resumes in the project folder under the same native session")
  assert.deepEqual([stranded.owner.session(live)?.cwd, stranded.owner.session(live)?.status], [main, "ready"])

  // One that failed against the missing folder before: the next message carries on all the same.
  const failedTree = join(root, "failed-worktree")
  mkdirSync(failedTree)
  const failing = fixture("failed-there", true, undefined, (cwd) => cwd === failedTree && !existsSync(cwd) ? main : undefined, new WorkspaceSnapshots(gitRunner, join(root, "failed-snapshots")))
  owners.push(failing.owner)
  const failed = randomUUID()
  await failing.owner.start("failed-there", failedTree, { conversationId: failed })
  failing.owner.submit(failed, randomUUID(), "work in the worktree")
  await until(() => failing.owner.snapshot(failed)?.requests[0]?.status === "completed" && failing.owner.lifecycleWork().length === 0)
  await delay(10)
  rmSync(failedTree, { recursive: true })
  failing.owner.observe({ type: "live-session", session: { ...failing.owner.session(failed)!, status: "failed", error: `ENOENT: no such file or directory, realpath '${failedTree}'` } })
  assert.equal(failing.owner.session(failed)?.status, "failed")
  failing.owner.submit(failed, randomUUID(), "try again")
  await until(() => failing.owner.snapshot(failed)?.requests[1]?.status === "completed")
  assert.deepEqual([failing.starts.at(-1)!.cwd, failing.owner.session(failed)?.status, failing.owner.session(failed)?.error], [main, "ready", undefined])

  // A harness that can't resume elsewhere is left to say its folder is gone.
  const pinnedTree = join(root, "pinned-worktree")
  mkdirSync(pinnedTree)
  const pinned = fixture("pinned-there", false, undefined, (cwd) => cwd === pinnedTree && !existsSync(cwd) ? main : undefined, new WorkspaceSnapshots(gitRunner, join(root, "pinned-snapshots")))
  owners.push(pinned.owner)
  const stays = randomUUID()
  await pinned.owner.start("pinned-there", pinnedTree, { conversationId: stays })
  pinned.owner.submit(stays, randomUUID(), "work in the worktree")
  await until(() => pinned.owner.snapshot(stays)?.requests[0]?.status === "completed" && pinned.owner.lifecycleWork().length === 0)
  await delay(10)
  rmSync(pinnedTree, { recursive: true })
  pinned.owner.submit(stays, randomUUID(), "after it was removed")
  await until(() => pinned.owner.snapshot(stays)?.requests[1]?.status === "failed")
  assert.deepEqual([pinned.closes(), pinned.starts.length, pinned.owner.session(stays)?.cwd], [0, 1, pinnedTree], "nothing restarts it")

  // A conversation closed in its worktree, reopened after the worktree was removed: its native session resumes in the project folder.
  const closedTree = join(root, "closed-worktree")
  mkdirSync(closedTree)
  const reopening = fixture("reopens", true, undefined, (cwd) => cwd === closedTree && !existsSync(cwd) ? main : undefined)
  owners.push(reopening.owner)
  const closed = randomUUID()
  await reopening.owner.start("reopens", closedTree, { conversationId: closed })
  reopening.owner.submit(closed, randomUUID(), "work in the worktree")
  await until(() => reopening.owner.snapshot(closed)?.requests[0]?.status === "completed" && reopening.owner.lifecycleWork().length === 0)
  await reopening.owner.close(closed)
  rmSync(closedTree, { recursive: true })
  const reopened = randomUUID()
  await reopening.owner.start("reopens", closedTree, { conversationId: reopened, resume: "native-reopens" })
  assert.equal(reopening.owner.session(reopened)?.cwd, main)
  reopening.owner.submit(reopened, randomUUID(), "after the worktree went")
  await until(() => ["completed", "failed"].includes(reopening.owner.snapshot(reopened)?.requests[0]?.status ?? ""))
  assert.equal(reopening.owner.snapshot(reopened)?.requests[0]?.error, undefined)
  assert.deepEqual([reopening.starts.at(-1)!.cwd, reopening.starts.at(-1)!.options.resume], [main, "native-reopens"])
  assert.deepEqual([reopening.owner.session(reopened)?.cwd, reopening.owner.session(reopened)?.status], [main, "ready"])
  // Closed in its worktree and written to again as it is, after the worktree went: the message reopens it in the project folder.
  const writtenTree = join(root, "written-worktree")
  mkdirSync(writtenTree)
  const writing = fixture("written-closed", true, undefined, (cwd) => cwd === writtenTree && !existsSync(cwd) ? main : undefined)
  owners.push(writing.owner)
  const written = randomUUID()
  await writing.owner.start("written-closed", writtenTree, { conversationId: written })
  writing.owner.submit(written, randomUUID(), "work in the worktree")
  await until(() => writing.owner.snapshot(written)?.requests[0]?.status === "completed" && writing.owner.lifecycleWork().length === 0)
  await writing.owner.close(written)
  rmSync(writtenTree, { recursive: true })
  writing.owner.submit(written, randomUUID(), "carry on")
  await until(() => ["completed", "failed"].includes(writing.owner.snapshot(written)?.requests[1]?.status ?? ""))
  assert.equal(writing.owner.snapshot(written)?.requests[1]?.error, undefined, "a message to a closed conversation isn't left queued")
  assert.deepEqual([writing.starts.at(-1)!.cwd, writing.starts.at(-1)!.options.resume], [main, "native-written-closed"], "it reopens under the same native session in the project folder")
  assert.deepEqual([writing.owner.session(written)?.status, writing.owner.session(written)?.connection], ["ready", "connected"])

  // Closed where its folder still is: the next message reopens it there.
  const plain = fixture("closed-plainly", true)
  owners.push(plain.owner)
  const closedPlainly = randomUUID()
  await plain.owner.start("closed-plainly", main, { conversationId: closedPlainly })
  plain.owner.submit(closedPlainly, randomUUID(), "seed")
  await until(() => plain.owner.snapshot(closedPlainly)?.requests[0]?.status === "completed" && plain.owner.lifecycleWork().length === 0)
  await plain.owner.close(closedPlainly)
  plain.owner.submit(closedPlainly, randomUUID(), "again")
  await until(() => plain.owner.snapshot(closedPlainly)?.requests[1]?.status === "completed")
  assert.deepEqual([plain.starts.length, plain.starts.at(-1)!.cwd, plain.starts.at(-1)!.options.resume], [2, main, "native-closed-plainly"])

  // One with no native session to resume refuses the message instead of holding it.
  const fresh = fixture("closed-unlaunched", true)
  owners.push(fresh.owner)
  const unlaunched = randomUUID()
  await fresh.owner.start("closed-unlaunched", main, { conversationId: unlaunched })
  await fresh.owner.close(unlaunched)
  assert.throws(() => fresh.owner.submit(unlaunched, randomUUID(), "hello"), /was closed before it started/)

  const pinnedClosedTree = join(root, "pinned-closed-worktree")
  mkdirSync(pinnedClosedTree)
  const pinnedReopen = fixture("pinned-reopens", false, undefined, (cwd) => cwd === pinnedClosedTree && !existsSync(cwd) ? main : undefined)
  owners.push(pinnedReopen.owner)
  rmSync(pinnedClosedTree, { recursive: true })
  const stillPinned = randomUUID()
  await pinnedReopen.owner.start("pinned-reopens", pinnedClosedTree, { conversationId: stillPinned, resume: "native-pinned-reopens" })
  assert.equal(pinnedReopen.owner.session(stillPinned)?.cwd, pinnedClosedTree, "a harness that can't resume elsewhere isn't moved")
  console.log("Conversation relocate: an idle session sleeps, moves and is resumed in the new folder under its native ID before anyone writes; one that doesn't resume goes back to its folder, asleep and usable; mid-turn or mid-checkpoint it waits, then goes; undeclared, nothing changes; one whose worktree was removed goes on in the project folder, asleep or still connected there, failed there before or not")
} finally {
  for (const owner of owners) await owner.stop()
  rmSync(root, { recursive: true, force: true })
}
