import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { Git } from "@mako/git"
import { decodeOperation } from "@mako/protocol"
import { cloudRuntimeOf as protocolRuntimeOf, continueCloudThread, continueHandOver, namedUuid as protocolUuid, type ContinueState } from "@mako/protocol/continues"
import type { MoveAnswer } from "@mako/protocol/moves"
import { fromHostOperation } from "@mako/host/contracts/host-operations"
import { encodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import { CloudMoves, MovePlanSchema, cloudRuntimeOf, namedUuid, onBranchHere, type CloudMovesOptions } from "@mako/host/conversations/cloud-moves"
import { arriveMove, MoveArrivalInputSchema, type MoveArrivalDeps } from "@mako/host/conversations/move-arrival"
import type { ThreadMoveStep } from "@mako/host/contracts/cloud-threads"
import { HandoffSchema } from "@mako/host/contracts/thread-execution"
import { MoveNotQuietError } from "@mako/host/conversations/live-moves"
import { ThreadStore } from "@mako/host/threads/store"

/**
 * A Session continued in the cloud while its Mac is off (`@mako/protocol/continues`), at Mako's end: the hand-over the
 * account composes is one this host's own contracts take (each operation a host call whose input parses, the arrival's
 * handoff the store's own), the machine's arrival with no checkpoint starts from its clone and says that start, and a
 * Mac that comes back joins the continue as a move: released at the generation the account released, the cloud's
 * claim confirmed (or its refusal taken back), never run here meanwhile.
 */
const root = mkdtempSync(join(tmpdir(), "mako-continues-"))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()
let clock = 1_000
/** What a joined continue never asks of the account. */
const unasked = (what: string) => async (): Promise<never> => {
  throw new Error(`a joined continue ${what}`)
}

try {
  // The IDs a continue is made of are the host's own: the same named UUID, the same cloud runtime.
  assert.equal(await protocolUuid("mako continue\0x"), namedUuid("mako continue\0x"))
  assert.equal(await protocolRuntimeOf("t-0123456789abcdef"), cloudRuntimeOf("t-0123456789abcdef"))

  const mac = randomUUID()
  const phone = randomUUID()
  const account = randomUUID()
  const op = randomUUID()
  const cloudThread = await continueCloudThread(op)
  const remote = join(root, "remote.git")
  const checkout = join(root, "Users", "ana", "worktrees", "webhooks")
  sh(root, "init", "--bare", "--quiet", remote)
  sh(root, "clone", "--quiet", remote, checkout)
  writeFileSync(join(checkout, "a.txt"), "one\n")
  sh(checkout, "add", ".")
  sh(checkout, "commit", "--quiet", "-m", "base")
  sh(checkout, "checkout", "--quiet", "-b", "webhooks")
  sh(checkout, "push", "--quiet", "-u", "origin", "webhooks")

  const threads = new ThreadStore(join(root, "threads.sqlite"), { now: () => clock++, realPath: (path) => path })
  const conversation = randomUUID()
  const placed = threads.registerJournal({ conversationId: conversation, createdAt: clock++, harness: "codex", bindings: [{ provider: "codex", nativeId: "n-1", path: "/codex/n-1.jsonl" }] }, threads.person())
  const generation = threads.execution(placed.session)!.generation
  const state = (phase: ContinueState["phase"], extra: Partial<ContinueState> = {}): ContinueState => ({
    op, thread: placed.thread, from: mac, by: phone, cloudThread, folder: checkout, repository: { url: "https://github.com/ana/api", branch: "webhooks" },
    sessions: [{ session: placed.session, conversation, harness: "codex", nativeId: "n-1", generation, folder: checkout, holdings: { "codex:n-1": 4 }, freshness: { behind: true } }],
    phase, waiting: [], at: new Date(clock).toISOString(), changedAt: new Date(clock).toISOString(), ...extra,
  })

  // The account's hand-over, read by this host's own contracts.
  {
    const waiting = [{ id: randomUUID(), conversation, text: "and the retries" }]
    const request = await continueHandOver(state("making"), { account, actor: { kind: "client", client: "phone", deviceId: phone }, waiting, releasedAt: clock })
    const calls = request.operations.map((text) => fromHostOperation(decodeOperation(text)))
    assert.deepEqual(calls.map((call) => call.kind === "call" ? call.channel : call.problem.detail), ["mako:move-arrive", "mako:live-start", "mako:live-prompt"], "each one a host call whose input parses")
    const arrive = calls[0]!
    assert.ok(arrive.kind === "call")
    const arrival = MoveArrivalInputSchema.parse(arrive.args[0])
    assert.equal(arrival.checkpoint, undefined)
    const handoff = HandoffSchema.parse(arrival.handoff)
    assert.deepEqual(handoff.sessions.map((each) => [each.id, each.generation, each.journals]), [[placed.session, generation + 1, [conversation]]])
    assert.deepEqual(handoff.target, { kind: "cloud", runtime: cloudRuntimeOf(cloudThread) })
    const prompt = calls[2]!
    assert.ok(prompt.kind === "call")
    assert.deepEqual(prompt.args.slice(0, 3), [conversation, waiting[0]!.id, "and the retries"], "a message that waited runs once, under its own ID")
  }

  // A machine's arrival with no checkpoint: its clone, as it stands, is the Thread's start, sent beside its records,
  // marked so a repeat says the same start and never takes the clone again over what an agent did since.
  {
    const machine = join(root, "machine", "Users", "ana", "worktrees", "webhooks")
    sh(root, "clone", "--quiet", "--branch", "webhooks", remote, machine)
    const sent = new Map<string, number>()
    const server = createServer((request, response) => {
      const sha = request.url?.split("/checkpoints/")[1] ?? ""
      if (request.method === "HEAD") {
        response.writeHead(sent.has(sha) ? 200 : 404).end()
        return
      }
      let bytes = 0
      request.on("data", (chunk: Buffer) => { bytes += chunk.length })
      request.on("end", () => {
        sent.set(sha, bytes)
        response.writeHead(201).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = z.object({ port: z.number() }).parse(server.address())
    try {
      const order: string[] = []
      const deps: MoveArrivalDeps = {
        git,
        records: () => ({ id: "t", base: `http://127.0.0.1:${port}/v1/threads/${cloudThread}/records`, authorization: "Bearer made-up" }),
        workspace: () => machine,
        workspaceProblem: () => undefined,
        workspaceSettled: async () => ({ path: machine }),
        warm: async () => {},
        receive: async (_link, sessions) => sessions.map((session) => ({ harness: session.harness, nativeId: session.nativeId, pulled: { versions: 1, held: 0, chunks: 1, bytes: 1, requests: 1, ms: 1 }, restored: { kind: "restored" as const, path: `/home/node/${session.nativeId}`, files: 1, rows: 0, ms: 1 } })),
        stage: async () => [],
        installed: () => null,
        open: async (session) => void order.push(`open ${session.conversationId}`),
        take: () => void order.push("take"),
        signedIn: () => true,
        label: (harness) => harness,
        scratch: join(root, "scratch"),
      }
      const input = MoveArrivalInputSchema.parse({ move: op, folder: machine, sessions: [{ harness: "codex", nativeId: "n-1", open: { conversationId: conversation } }] })
      const arrived = await arriveMove(deps, input)
      assert.equal(arrived.checkout, "copy")
      assert.ok(arrived.start, "it says the checkout it starts from")
      assert.equal(arrived.start.head, sh(machine, "rev-parse", "HEAD"), "the clone's own head")
      assert.equal(sent.get(arrived.start.sha256), arrived.start.bytes, "sent beside the Thread's records")
      assert.deepEqual(order, ["open " + conversation])
      writeFileSync(join(machine, "a.txt"), "an agent's change since\n")
      const again = await arriveMove(deps, input)
      assert.equal(again.checkout, "arrived")
      assert.deepEqual(again.start, arrived.start, "asked again, the same start; the agent's change since is never taken over it")
      assert.equal(readFileSync(join(machine, "a.txt"), "utf8"), "an agent's change since\n")
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  }

  // A Mac back from sleep joins the continue: it releases the Thread at the account's generation and confirms the
  // cloud's claim, so the Thread runs in the cloud and never here; asked again, nothing more happens.
  const start = { version: 1 as const, sha256: "a".repeat(64), bytes: 10, head: "b".repeat(40), index: "c".repeat(40), work: "d".repeat(40), branch: "webhooks" }
  const harness = (answer: () => MoveAnswer | undefined, continued: () => ContinueState | undefined, busy: string[] = [], calls?: Array<{ channel: string; args: readonly unknown[] }>, here: string[] = []) => {
    const steps: ThreadMoveStep[] = []
    const adopted: string[] = []
    const carriedOn: string[] = []
    const ended = new Set<string>()
    const options: CloudMovesOptions = {
      folder: join(root, `moves-${randomUUID()}`),
      git,
      account: () => ({
        token: async () => "made-up",
        gateway: () => undefined,
        id: async () => account,
        session: () => { throw new Error("a joined continue opens no session") },
        deviceId: async () => mac,
        createThread: unasked("makes no cloud Thread: the account made it"),
        askBases: unasked("asks for no base"),
        sendCheckpoint: unasked("sends no checkpoint"),
        handOverMove: unasked("hands nothing over: the account did"),
        moveAnswer: async () => answer(),
        refuseMove: unasked("never refuses: it isn't this Mac's to refuse"),
        continueState: async (_session: string, _op: string, given?: { carryOn?: boolean }) => {
          if (given?.carryOn) carriedOn.push(_op)
          return continued()
        },
        threadRecords: unasked("reads no Thread's records"),
        deviceRecords: unasked("reads no device's records"),
        deviceOriginals: unasked("reads no originals"),
        readCheckpoint: unasked("reads no checkpoint"),
        beginReturn: unasked("begins no return"),
        releaseReturn: unasked("releases no return"),
        cancelReturn: unasked("cancels no return"),
        giveBackReturn: unasked("gives back no return"),
        finishReturn: unasked("finishes no return"),
        archiveReturn: unasked("archives no return"),
        returnState: unasked("reads no return"),
        wake: () => undefined,
        stop: () => undefined,
      }),
      threads: () => threads,
      moves: {
        settledBlockers: async () => [...busy],
        begin: (input) => threads.beginMove(input),
        cancel: (input) => threads.cancelMove(input),
        release: async (input) => {
          if (busy.length) throw new MoveNotQuietError(busy)
          return threads.release(input)
        },
        confirm: (input) => threads.confirm(input),
        reclaim: (input) => threads.reclaim(input),
      },
      snapshot: (id) => (id === conversation ? { session: { harness: "codex", nativeId: "n-1", nativePath: "/codex/n-1.jsonl", cwd: checkout, currentMode: null } } : null),
      checkout: () => ({ path: checkout, worktrees: [{ path: checkout }] }),
      repositoryOf: async () => ({ url: "https://github.com/ana/api", branch: "webhooks" }),
      sendRecords: async () => { throw new Error("a joined continue sends nothing: the account had it all") },
      cloud: {
        adopt: async (each) => void adopted.push(`${each.conversationId} ${each.threadId}`),
        callThread: async (_thread, channel, args) => {
          if (!calls) throw new Error("nothing is asked of the machine")
          calls.push({ channel, args })
          return encodeRuntimeValue(null)
        },
      },
      live: { handOff: async () => undefined, continueTurn: (_conversation, input) => void here.push(input.continues), waitingPrompts: () => [], carried: () => undefined },
      remembered: () => null,
      step: (_conversation, _move, step) => void steps.push(step),
      ended: (move) => void ended.add(move),
      newCloudThread: () => "t-unused",
    }
    return { moves: new CloudMoves(options), steps, adopted, carriedOn, ended, folder: options.folder, here }
  }
  const listed = { op, phase: "continued" as const, from: mac, by: phone, cloudThread, at: new Date(clock).toISOString() }
  // A joined continue has run its course here once its move ended, however it ended.
  const settle = async (joined: { ended: ReadonlySet<string> }, move: string) => {
    while (!joined.ended.has(move)) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  // At work here (a person typed in the first seconds back): nothing is given up until the turn ends.
  {
    const busy = harness(() => undefined, () => state("continued", { start }), ["Codex: a turn"])
    busy.moves.joinContinue(placed.session, listed)
    await settle(busy, op)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(threads.execution(placed.session)?.state, "here")
  }

  // A store that went on to another generation can't be the one the account released: nothing is given up.
  {
    const wrong = harness(() => undefined, () => state("continued", { start, sessions: [{ ...state("continued").sessions[0]!, generation: generation + 5 }] }))
    wrong.moves.joinContinue(placed.session, listed)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(threads.execution(placed.session)?.state, "here")
  }

  {
    const claimed: MoveAnswer = { kind: "claimed", move: op, at: clock, sessions: [{ id: placed.session, generation: generation + 2 }] }
    const calls: Array<{ channel: string; args: readonly unknown[] }> = []
    const joined = harness(() => claimed, () => state("continued", { start }), [], calls)
    // A turn this Mac paused as it went to sleep and couldn't hand off in time, parked for the Thread, goes on in the
    // cloud with the continue, as Mako's (`CloudMoves.unpark` would have continued it here).
    const parked = randomUUID()
    mkdirSync(joined.folder, { recursive: true })
    writeFileSync(join(joined.folder, "parked-turns"), JSON.stringify({ version: 1, turns: [{ move: randomUUID(), thread: placed.thread, conversationId: conversation, requestId: parked, stopped: ["npm run dev"], at: Date.now() }] }))
    joined.moves.joinContinue(placed.session, listed)
    joined.moves.joinContinue(placed.session, listed)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await settle(joined, op)
    const execution = threads.execution(placed.session)
    assert.equal(execution?.state, "elsewhere", "it runs in the cloud now, never here")
    assert.equal(execution?.generation, generation + 2, "at the generation the cloud claimed")
    assert.ok(execution?.state === "elsewhere" && execution.owner.kind === "cloud" && execution.owner.runtime === cloudRuntimeOf(cloudThread))
    assert.deepEqual(joined.carriedOn, [op], "the account was asked to carry it on, once")
    assert.deepEqual(joined.adopted, [`${conversation} ${cloudThread}`], "followed here as the cloud's, as a moved Thread is")
    assert.deepEqual(joined.steps.map((step) => step.kind), ["resuming", "moved"])
    assert.deepEqual(calls.map(({ channel, args }) => [channel, args[0], args[2]]), [["mako:live-continue-turn", conversation, { reason: "handed-off", continues: parked, stopped: ["npm run dev"] }]], "the parked turn goes on in the cloud")
    assert.deepEqual(z.object({ turns: z.array(z.unknown()) }).parse(JSON.parse(readFileSync(join(joined.folder, "parked-turns"), "utf8"))).turns, [], "and is parked here no more")
    const plan = MovePlanSchema.parse(JSON.parse(readFileSync(join(joined.folder, `${op}.json`), "utf8")))
    assert.equal(plan.phase, "started")
    assert.deepEqual(plan.checkpoint, start, "weighed against what the cloud began with, as a move is against what it sent")
    assert.equal(plan.continued?.behind, true, "and it remembers that the cloud began from before its last turns")
    assert.equal(plan.branch, "webhooks", "and the branch its worktree here was on")
    // The machine's checkout comes back on this Mac's branch while the machine stays on the branch it cloned; one it
    // went onto is laid as it's named.
    const named = { ...plan, branch: "proof-x" }
    assert.equal(onBranchHere(start, named).branch, "proof-x")
    assert.equal(onBranchHere({ ...start, branch: "spike" }, named).branch, "spike")
    assert.equal(onBranchHere(start, plan).branch, "webhooks")
    assert.equal(plan.handoff?.sessions[0]?.generation, generation + 1, "the way back reads its own handoff")
    joined.moves.joinContinue(placed.session, listed)
    assert.ok(!joined.moves.leaving(placed.thread), "heard again, nothing more")
  }

  // Refused while this Mac was away (the machine couldn't take it): a Mac that joined takes it back.
  {
    const refusedOp = randomUUID()
    const second = randomUUID()
    const back = threads.registerJournal({ conversationId: second, createdAt: clock++, harness: "codex", bindings: [{ provider: "codex", nativeId: "n-2", path: "/codex/n-2.jsonl" }] }, threads.person())
    const g = threads.execution(back.session)!.generation
    const refused: MoveAnswer = { kind: "refused", move: refusedOp, at: clock, reason: "Codex couldn't start in the cloud" }
    const refusing = harness(() => refused, () => ({
      ...state("arriving"), op: refusedOp, thread: back.thread,
      sessions: [{ session: back.session, conversation: second, harness: "codex", nativeId: "n-2", generation: g, folder: checkout }],
    }))
    // A turn this Mac parked for the Thread as it went off: refused, it goes on here at once, not at the next owner check.
    mkdirSync(refusing.folder, { recursive: true })
    const parkedTurn = randomUUID()
    writeFileSync(join(refusing.folder, "parked-turns"), JSON.stringify({ version: 1, turns: [{ move: randomUUID(), thread: back.thread, conversationId: second, requestId: parkedTurn, stopped: [], at: Date.now() }] }))
    refusing.moves.joinContinue(back.session, { ...listed, op: refusedOp, phase: "arriving" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await settle(refusing, refusedOp)
    const execution = threads.execution(back.session)
    assert.equal(execution?.state, "here", "taken back: it runs here again")
    assert.equal(execution?.generation, g + 2)
    assert.deepEqual(refusing.steps.at(-1), { kind: "kept-here", reason: "Codex couldn't start in the cloud" })
    assert.deepEqual(refusing.adopted, [])
    assert.deepEqual(refusing.here, [parkedTurn], "the parked turn goes on here")
    assert.deepEqual(z.object({ turns: z.array(z.unknown()) }).parse(JSON.parse(readFileSync(join(refusing.folder, "parked-turns"), "utf8"))).turns, [])
  }

  // A continue that failed while this Mac was away: nothing went anywhere, and the parked turn goes on here at once.
  {
    const failedOp = randomUUID()
    const third = randomUUID()
    const stayed = threads.registerJournal({ conversationId: third, createdAt: clock++, harness: "codex", bindings: [{ provider: "codex", nativeId: "n-3", path: "/codex/n-3.jsonl" }] }, threads.person())
    const failing = harness(() => undefined, () => ({ ...state("failed"), op: failedOp, thread: stayed.thread, reason: "The cloud is full" }))
    mkdirSync(failing.folder, { recursive: true })
    const parkedTurn = randomUUID()
    writeFileSync(join(failing.folder, "parked-turns"), JSON.stringify({ version: 1, turns: [{ move: randomUUID(), thread: stayed.thread, conversationId: third, requestId: parkedTurn, stopped: [], at: Date.now() }] }))
    failing.moves.joinContinue(stayed.session, { ...listed, op: failedOp, phase: "arriving" })
    await settle(failing, failedOp)
    assert.equal(threads.execution(stayed.session)?.state, "here")
    assert.deepEqual(failing.here, [parkedTurn], "the parked turn goes on here")
  }
  console.log("PASS: a continue in the cloud is the device's own move composed by the account (host calls this host takes, its store's handoff, the host's IDs); a machine with no checkpoint starts from its clone and says so, once; a Mac back from sleep joins it at the account's generation and confirms the claim, takes a refusal back, and gives up nothing while it works or its generation differs")
  threads.close()
} finally {
  git.close()
  rmSync(root, { recursive: true, force: true })
}
