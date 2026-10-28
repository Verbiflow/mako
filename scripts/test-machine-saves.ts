import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { MachineSaveSchema, type MachineSave, type SavedConversation } from "@mako/protocol/saves"
import type { ReceivedRecords } from "@mako/sessions/record-sync"
import { MachineSaves, type MachineSaveLink } from "@mako/host/conversations/machine-saves"
import { restoreSave } from "@mako/host/conversations/machine-restore"
import type { ArrivingSession, MoveArrivalDeps } from "@mako/host/conversations/move-arrival"
import { continueTurnPrompt, savedContinuation } from "@mako/host/contracts/turn-continuation"
import { readReason, savedReason } from "@mako/host/contracts/live-conversations"
import { HandoffSchema, type Handoff } from "@mako/host/contracts/thread-execution"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { sendThreadCarry } from "@mako/host/conversations/move-departure"
import { ARRIVED_CARRY } from "@mako/host/conversations/move-arrival"
import { captureMoveCheckpoint } from "@mako/host/workspaces/move-checkpoint"
import type { MoveCarry } from "@mako/protocol/moves"

/**
 * The machine tracker (`machine-saves.ts`) and a new machine's restore (`machine-restore.ts`), on real repositories,
 * against a stand-in for the gateway's machine routes: a call that could write ends and the checkout is saved within
 * a second, the same checkout is never sent twice, a turn's end waits for its save, a save fenced by a newer
 * generation stops the saves for good; and a new machine restores the save (its checkout onto a fresh clone, its
 * sessions opened under the Thread's IDs, the cut turn continued as `machine-lost`), once, and never a save of its own
 * generation. A Thread that came with a move's carry (another repository, a file outside its folder) saves the rest of
 * it too, and a new machine lays it down as a move would: the other repository cloned and its changes applied, the
 * outside file at its own path.
 */
const outsideRoot = mkdtempSync("/tmp/mako-machine-saves-")

const root = await mkdtemp(join(tmpdir(), "mako-machine-saves-"))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()

/** What the stand-in keeps and how it answers: the Thread's save, and whether it refuses one. */
type FakeGatewayState = { kept?: { generation: number; save: MachineSave }; fence?: boolean; restoreFirst?: boolean; checkpointPuts: number }

/** The gateway's machine routes, as far as a machine uses them: checkpoints beside the records, and the Thread's save. */
function gateway() {
  const checkpoints = new Map<string, Buffer>()
  const puts: MachineSave[] = []
  const state: FakeGatewayState = { checkpointPuts: 0 }
  const body = (request: IncomingMessage) => new Promise<Buffer>((resolve) => {
    const parts: Buffer[] = []
    request.on("data", (part: Buffer) => parts.push(part)).on("end", () => resolve(Buffer.concat(parts)))
  })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://gateway.test")
    const sha = /\/checkpoints\/([0-9a-f]{64})$/.exec(url.pathname)?.[1]
    if (sha && request.method === "HEAD") return response.writeHead(checkpoints.has(sha) ? 200 : 404).end()
    if (sha && request.method === "PUT") {
      checkpoints.set(sha, await body(request))
      state.checkpointPuts += 1
      return response.writeHead(201).end("{}")
    }
    if (sha && request.method === "GET") return checkpoints.has(sha) ? response.writeHead(200).end(checkpoints.get(sha)) : response.writeHead(404).end()
    if (url.pathname.endsWith("/save") && request.method === "PUT") {
      if (state.fence) return response.writeHead(409).end('{"title":"This machine no longer runs its Thread","detail":"fenced"}')
      if (state.restoreFirst) return response.writeHead(409).end('{"title":"This machine hasn\'t restored its Thread\'s save yet","detail":"restore-first"}')
      const save = MachineSaveSchema.parse(JSON.parse((await body(request)).toString("utf8")))
      puts.push(save)
      state.kept = { generation: 1, save }
      return response.writeHead(200).end('{"kept":true}')
    }
    if (url.pathname.endsWith("/save") && request.method === "GET") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state.kept ?? { save: null }))
    response.writeHead(404).end()
  })
  return { server, checkpoints, puts, state }
}

try {
  const fake = gateway()
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve))
  // SAFETY: a server listening on a TCP port, not a pipe, has an AddressInfo address.
  const base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`
  const link: MachineSaveLink = {
    records: { id: `${base}/v1/machines/m-1/records`, base: `${base}/v1/machines/m-1/records`, authorization: "Bearer test" },
    save: { url: `${base}/v1/machines/m-1/save`, authorization: "Bearer test" },
  }
  // The remote, and the machine's clone of it with work of the Thread's on top.
  const remote = join(root, "remote.git")
  sh(root, "init", "--bare", "--quiet", remote)
  sh(remote, "config", "uploadpack.allowFilter", "true")
  const machine = join(root, "machine")
  sh(root, "clone", "--quiet", remote, machine)
  await writeFile(join(machine, "README"), "hello\n")
  sh(machine, "add", ".")
  sh(machine, "commit", "--quiet", "-m", "first")
  sh(machine, "push", "--quiet", "origin", "main")

  const conversation = randomUUID()
  // The machine store's Thread, as a release names it.
  const handoff = HandoffSchema.parse({ move: randomUUID(), source: { kind: "cloud", runtime: randomUUID() }, target: { kind: "cloud", runtime: randomUUID() }, releasedAt: 1, thread: { id: randomUUID(), owner: randomUUID() }, sessions: [{ id: randomUUID(), origin: "started", position: 0, generation: 2, journals: [conversation] }] })
  const saves = new MachineSaves({
    git,
    scratch: join(root, "scratch"),
    memoryScratch: join(root, "memory"),
    link: () => link,
    workspace: () => machine,
    // As the tracker names them: the request "r-1" answers while its turn runs, by the turn's own start and end.
    conversations: (turns) => {
      const saved: SavedConversation = { conversationId: conversation, harness: "codex", nativeId: "n-1", modeId: "access:full", tuning: { model: "gpt-5.5" } }
      const call = turns.get("r-1")
      if (turns.has("r-1")) saved.turn = call ? { requestId: "r-1", running: call } : { requestId: "r-1" }
      return [saved]
    },
    // Read afresh for each save, as the store reads it: the moment it's read differs each time, nothing else.
    // As the store reads an untitled Thread: its title's key is there, undefined, which JSON has no word for.
    handoff: () => ({ ...handoff, thread: { ...handoff.thread, title: undefined, titleSource: undefined }, releasedAt: Date.now() }),
  })
  const waitFor = async (what: () => boolean, label: string) => {
    for (const deadline = Date.now() + 10_000; !what(); await new Promise((resolve) => setTimeout(resolve, 20)))
      if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
  }

  // A call that could write ends: the checkout, an uncommitted edit and an untracked file, saved within a second.
  await writeFile(join(machine, "README"), "hello\nedited on the machine\n")
  await writeFile(join(machine, "notes.txt"), "untracked\n")
  saves.activity({ kind: "turn", edge: "start", id: "r-1" })
  saves.activity({ kind: "call", edge: "start", id: "c-1", turn: "r-1", label: "npm test" })
  saves.activity({ kind: "call", edge: "end", id: "c-1", turn: "r-1", label: "npm test" })
  await waitFor(() => fake.puts.length === 1, "the first save")
  const first = fake.puts[0]!
  assert.ok(first.checkpoint, "a checkpoint")
  assert.equal(fake.checkpoints.has(first.checkpoint.sha256), true, "sent beside the records")
  assert.deepEqual(first.conversations[0]?.turn, { requestId: "r-1" }, "the call ended: nothing runs in it now")
  assert.ok(first.disk && first.disk.totalBytes > 0 && first.disk.freeBytes >= 0, "the disk it's on")
  assert.equal(HandoffSchema.parse(first.handoff).thread.id, handoff.thread.id, "the store's Thread, under its IDs")

  // A read-only call ends: nothing saved. A call runs: its running command is what a save says was cut.
  saves.activity({ kind: "call", edge: "end", id: "c-2", turn: "r-1", label: "git status", readOnly: true })
  saves.activity({ kind: "call", edge: "start", id: "c-3", turn: "r-1", label: "npm run build" })
  await saves.settle("asked")
  assert.equal(fake.puts.length, 2, "the running call changed what a save says")
  assert.deepEqual(fake.puts[1]?.conversations[0]?.turn, { requestId: "r-1", running: "npm run build" })
  assert.equal(fake.state.checkpointPuts, 1, "the same checkout is never sent twice")

  // Nothing changed: nothing sent; but a turn's end always says its save, so the Thread hears it came after the work.
  const sent = fake.puts.length
  saves.changed("nothing changed")
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  assert.equal(fake.puts.length, sent, "a save that says nothing new isn't sent")
  await saves.settle("a turn ended, nothing new")
  assert.equal(fake.puts.length, sent + 1, "a turn's end is sent whatever it says")
  // A change, then a turn's end: the save waited for is the newest.
  await writeFile(join(machine, "notes.txt"), "untracked, changed\n")
  saves.activity({ kind: "turn", edge: "end", id: "r-1" })
  await saves.settle("a turn ended")
  const last = fake.puts.at(-1)!
  assert.equal(last.conversations[0]?.turn, undefined, "idle: no turn to continue")
  assert.notEqual(last.checkpoint?.sha256, first.checkpoint.sha256, "the newest change is in it")

  // A new machine of generation 2 restores it: the checkout onto a fresh clone, the Thread taken under its IDs, each
  // session opened, and the cut turn continued as the machine's loss.
  fake.state.kept = { generation: 1, save: { ...first, folder: join(root, "fresh") } }
  const fresh = join(root, "fresh")
  sh(root, "clone", "--quiet", remote, fresh)
  const order: string[] = []
  const opened: ArrivingSession[] = []
  const continued: Array<{ conversationId: string; reason: string; continues: string; requestId: string }> = []
  const taken: Handoff[] = []
  const arrival: MoveArrivalDeps = {
    git,
    records: () => link.records,
    workspace: () => fresh,
    workspaceProblem: () => undefined,
    workspaceSettled: async () => ({ path: fresh }),
    warm: async () => {},
    receive: async (_link, sessions) => {
      order.push("receive")
      return sessions.map((session): ReceivedRecords => ({ harness: session.harness, nativeId: session.nativeId, pulled: { versions: 1, held: 0, chunks: 1, bytes: 1, requests: 1, ms: 1 }, restored: { kind: "restored", path: `/home/node/${session.nativeId}`, files: 1, rows: 0, ms: 1 } }))
    },
    stage: async () => [],
    installed: () => null,
    open: async (session) => {
      order.push(`open ${session.harness}`)
      opened.push(session)
    },
    take: (handoff) => void (order.push("take"), taken.push(handoff)),
    signedIn: () => true,
    label: (harness) => harness,
    scratch: join(root, "moves"),
  }
  fake.state.kept.save = { ...fake.state.kept.save, handoff }
  const deps = { arrival, continueTurn: (conversationId: string, input: { requestId: string; reason: "machine-lost"; continues: string }) => void continued.push({ conversationId, ...input }) }
  const restored = await restoreSave(deps, link, "m-1", 2)
  assert.ok(restored, "restored")
  assert.equal(restored.checkout, "applied")
  assert.equal(await readFile(join(fresh, "README"), "utf8"), "hello\nedited on the machine\n", "the uncommitted edit came along")
  assert.equal(await readFile(join(fresh, "notes.txt"), "utf8"), "untracked\n", "the untracked file too")
  // Unstaged, untracked: as it stood there (the first column, the index's, is blank: `sh` trims the line's lead).
  assert.equal(sh(fresh, "status", "--porcelain=v1"), "M README\n?? notes.txt", "and reads as it did there")
  assert.equal(sh(fresh, "diff", "--cached", "--name-only"), "", "nothing staged that wasn't")
  assert.deepEqual(order, ["receive", "take", "open codex"], "records first, the Thread taken before any session opens")
  assert.deepEqual({ ...opened[0], path: undefined }, { harness: "codex", nativeId: "n-1", path: undefined, folder: fresh, conversationId: conversation, modeId: "access:full", tuning: { model: "gpt-5.5" } }, "opened as it ran, under its own settings")
  assert.equal(taken[0]?.thread.id, handoff.thread.id, "the Thread under its own IDs")
  assert.notEqual(taken[0]?.move, handoff.move, "under the restore's move, named by the machine and both generations")
  assert.deepEqual(continued.map(({ conversationId, reason, continues }) => ({ conversationId, reason, continues })), [{ conversationId: conversation, reason: "machine-lost", continues: "r-1" }], "the cut turn continued, once")
  // Again (the host restarting before its first save): the checkout isn't written twice, the continuation is the same.
  const again = await restoreSave(deps, link, "m-1", 2)
  assert.equal(again?.checkout, "arrived", "its mark says the checkout arrived: work since is never written over")
  assert.equal(continued[1]?.requestId, continued[0]?.requestId, "the same continuation, which the conversation takes once")
  // Its own generation's save, or a later one's, is never restored.
  assert.equal(await restoreSave(deps, link, "m-1", 1), undefined)

  // The continuation's words: what the agent is told, read back from a saved conversation as the machine's loss.
  const prompt = continueTurnPrompt("machine-lost", "mako")
  assert.match(prompt, /previous turn was interrupted before it finished/)
  assert.deepEqual(savedContinuation(prompt), { reason: "machine-lost", sender: "mako" })
  assert.deepEqual(savedReason("machine-lost"), { reason: "handed-off", exactReason: "machine-lost" }, "older builds read it as a handoff")
  assert.equal(readReason("handed-off", "machine-lost"), "machine-lost")

  // Restoring, nothing is saved; released, the first save goes. A refusal to save before restoring isn't a fence.
  saves.hold()
  await writeFile(join(machine, "notes.txt"), "while restoring\n")
  const before = fake.puts.length
  saves.changed("a conversation opened")
  await saves.settle("a turn ended")
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  assert.equal(fake.puts.length, before, "held while restoring")
  saves.restoredFrom({ from: 1, ms: 900, conversations: 1 })
  await waitFor(() => fake.puts.length === before + 1, "the first save after the restore")
  assert.deepEqual(fake.puts.at(-1)?.restored, { from: 1, ms: 900, conversations: 1 }, "it says what it restored")
  fake.state.restoreFirst = true
  await writeFile(join(machine, "notes.txt"), "refused until restored\n")
  await saves.settle("refused")
  assert.equal(saves.state().fenced, undefined, "not restored yet isn't fenced")
  fake.state.restoreFirst = false

  // A newer generation took the Thread: this machine's save is refused, and it saves no more.
  fake.state.fence = true
  await writeFile(join(machine, "notes.txt"), "after the fence\n")
  await saves.settle("fenced")
  assert.ok(saves.state().fenced, "fenced")
  const puts = fake.puts.length
  fake.state.fence = false
  saves.changed("anything")
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  assert.equal(fake.puts.length, puts, "a fenced machine never saves again")
  saves.stop()

  // A Thread that came with a move's carry: a second repository beside the first, and a file outside its folder.
  const secondRemote = join(root, "second.git")
  sh(root, "init", "--bare", "--quiet", secondRemote)
  const first_ = join(root, "carried")
  const second = join(root, "carried-second")
  sh(root, "clone", "--quiet", remote, first_)
  sh(root, "clone", "--quiet", secondRemote, second)
  await writeFile(join(second, "lib.txt"), "lib\n")
  sh(second, "add", ".")
  sh(second, "commit", "--quiet", "-m", "lib")
  sh(second, "push", "--quiet", "origin", "main")
  const checkpointOf = async (path: string) => (await captureMoveCheckpoint(git, path, await mkdtemp(join(root, "capture-")))).checkpoint
  const arrivedCarry: MoveCarry = { version: 1, folder: first_, repositories: [{ path: first_, checkpoint: await checkpointOf(first_) }, { path: second, url: secondRemote, checkpoint: await checkpointOf(second) }], outside: [], gone: [], left: [], history: false }
  await writeFile(join(first_, ".git", ARRIVED_CARRY), JSON.stringify(arrivedCarry))
  // On the machine since: the second repository edited, the outside file written.
  await writeFile(join(second, "lib.txt"), "lib\nedited in the second repository\n")
  const outside = join(outsideRoot, "notes.md")
  await writeFile(outside, "outside the project\n")
  const thread = ThreadIdSchema.parse(randomUUID())
  const carrying = new MachineSaves({
    git,
    scratch: join(root, "scratch-carry"),
    memoryScratch: join(root, "memory-carry"),
    link: () => link,
    workspace: () => first_,
    conversations: () => [],
    handoff: () => undefined,
    carry: (folder, records, checkpoint) => sendThreadCarry({ git, scratch: join(root, "carry"), outside: () => [{ path: outside, access: "write" }], history: () => undefined }, { folder, thread, checkpoint }, records, "a save"),
  })
  fake.state.kept = undefined
  await carrying.settle("a turn ended")
  // Read as it is now, after the save: not as it was just set.
  const keptNow = (): FakeGatewayState["kept"] => fake.state.kept
  const carried = keptNow()?.save
  assert.ok(carried?.carry, "the save took the rest of the Thread")
  assert.equal(fake.checkpoints.has(carried.carry.sha256), true, "sent beside the records")
  carrying.stop()

  // A new machine: the first repository cloned again at its path, the second not there yet, the outside file gone.
  rmSync(first_, { recursive: true, force: true })
  rmSync(second, { recursive: true, force: true })
  rmSync(outside, { force: true })
  sh(root, "clone", "--quiet", remote, first_)
  const clonedHere: string[] = []
  const carryArrival: MoveArrivalDeps = {
    ...arrival,
    workspace: () => first_,
    workspaceSettled: async () => ({ path: first_ }),
    scratch: join(root, "moves-carry"),
    clone: async (repository) => {
      clonedHere.push(repository.path)
      sh(root, "clone", "--quiet", repository.url, repository.path)
    },
  }
  const back = await restoreSave({ arrival: carryArrival, continueTurn: () => {} }, link, "m-1", 2)
  assert.ok(back, "restored")
  assert.deepEqual(clonedHere, [second], "the other repository, missing here, cloned first")
  assert.equal(await readFile(join(second, "lib.txt"), "utf8"), "lib\nedited in the second repository\n", "its changes on the machine came along")
  assert.equal(await readFile(outside, "utf8"), "outside the project\n", "the outside file at its own path")
  assert.equal(existsSync(join(first_, ".git", ARRIVED_CARRY)), true, "the carry kept for the next save and the way back")

  fake.server.close()
  console.log("machine saves: saved after calls and turns, sent once, fenced for good; restored once, its turn continued; a carried Thread's other repository and outside file saved and laid down again")
} finally {
  await rm(root, { recursive: true, force: true })
  rmSync(outsideRoot, { recursive: true, force: true })
}
