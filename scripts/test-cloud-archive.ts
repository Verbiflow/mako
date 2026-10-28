import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { ClientSession, Operation, Reply } from "@mako/protocol"
import { ReturnBeginRequestSchema, ReturnReasonRequestSchema, ReturnReleaseRequestSchema, ReturnStateSchema, type ReturnDeparture, type ReturnState } from "@mako/protocol/moves"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { CloudArchiver, listedArchiveInputs, readCloudArchivePlan, type CloudArchivePlan, type CloudReturnSteps } from "@mako/host/contracts/cloud-archive"
import { fromHostOperation, hostFailure, hostSuccess } from "@mako/host/contracts/host-operations"
import { encodeRuntimeValue, type EncodedValue } from "@mako/host/contracts/runtime-value"
import type { JsonValue } from "@mako/host/contracts/json"
import type { CloudArchiveStep } from "@mako/host/contracts/thread-lifecycle"
import { z } from "zod"
import { archiveCloudThread, settleArchives, type ArchiveGateway, type ReturnRequest } from "../src/web-client/archive"
import { GatewayError } from "../src/web-client/gateway"

/**
 * A cloud Thread archived by the one procedure a Mac and a browser both run (`contracts/cloud-archive.ts`), against a
 * gateway that keeps the gateway's rules for a return to the archive (`returns.ts`: one record per return, which only
 * goes forward; a step it went past answers with the record) and a machine that packs or refuses. Archived; refused
 * while it works, in the person's words, with the Thread left as it was; a plan a stopped device left `begun` or
 * `released` settled when it next starts; two asks while one runs joined. Then the browser's own: the same procedure
 * over the gateway's API, its plans in the page's storage, settled after a reload.
 */

const THREAD = "t-0123456789abcdef"
const FOLDER = "/home/mako/work/api"
const commit = (digit: string) => digit.repeat(40)
const DEPARTURE: ReturnDeparture = {
  checkpoint: { version: 1, sha256: "a".repeat(64), bytes: 10, head: commit("1"), index: commit("2"), work: commit("3") },
  sessions: [{ harness: "codex", nativeId: "n-1", holdings: { "codex:n-1.jsonl": 5 } }],
}
/** What the machine is asked to pack. */
const DepartAskSchema = z.tuple([z.object({ move: z.uuid(), folder: z.string(), conversations: z.array(z.string()), device: z.uuid() }).strict()])

type Verdict = { kind: "apply" | "stands" | "past"; record: ReturnState } | { kind: "refused"; reason: string }
type Step = { step: "begin"; by: string } | { step: "release"; departure: ReturnDeparture } | { step: "cancel"; reason: string } | { step: "archive" }

/** The gateway's returns of one Thread, by its rules for an archive, and the Thread's machine. */
class Cloud {
  readonly records = new Map<string, ReturnState>()
  readonly calls: Array<{ channel: string; args: readonly unknown[] }> = []
  /** Set while the Thread works: the gateway refuses to begin, saying so, and nothing is begun. */
  busy: string | undefined
  /** How many of the next steps go unheard, as a network down would leave them. */
  unreachable = 0
  /** The machine's departure: what it packs, or why it can't. */
  depart: () => Promise<ReturnDeparture> = async () => DEPARTURE

  /** A step of a return, as `returnStep` at the gateway judges it and the Thread object then records it. */
  step(move: string, asked: Step): Verdict {
    if (this.unreachable > 0) {
      this.unreachable -= 1
      throw new Error("the network is down")
    }
    const record = this.records.get(move)
    const verdict = this.#judge(move, record, asked)
    if (verdict.kind === "apply") this.records.set(move, verdict.record)
    return verdict
  }

  #judge(move: string, record: ReturnState | undefined, asked: Step): Verdict {
    const at = Date.now()
    if (asked.step === "begin") {
      if (record) return record.phase === "returning" ? { kind: "stands", record } : { kind: "past", record }
      const archived = [...this.records.values()].find((each) => each.phase === "archived")
      if (archived) return { kind: "past", record: archived }
      if ([...this.records.values()].some((each) => each.phase === "returning")) return { kind: "refused", reason: "This Thread is being archived" }
      if (this.busy) return { kind: "refused", reason: this.busy }
      return { kind: "apply", record: { phase: "returning", move, at, to: "archive", by: asked.by } }
    }
    if (!record) return { kind: "refused", reason: "This return wasn't begun" }
    const mark = { to: "archive" as const, ...(record.by && { by: record.by }) }
    if (asked.step === "release") return record.phase === "returning" ? { kind: "apply", record: { phase: "released", move, at, departure: asked.departure, ...mark } } : record.phase === "released" ? { kind: "stands", record } : { kind: "past", record }
    if (asked.step === "cancel") return record.phase === "returning" ? { kind: "apply", record: { phase: "cancelled", move, at, reason: asked.reason, ...mark } } : record.phase === "cancelled" ? { kind: "stands", record } : { kind: "past", record }
    if (record.phase === "released") return { kind: "apply", record: { phase: "archived", move, at, departure: record.departure, ...mark } }
    if (record.phase === "returning") return { kind: "apply", record: { phase: "archived", move, at, ...mark } }
    return record.phase === "archived" ? { kind: "stands", record } : { kind: "past", record }
  }

  /** The machine, through its Thread: it packs, or refuses saying why. */
  async callThread(channel: string, args: readonly unknown[]): Promise<EncodedValue> {
    this.calls.push({ channel, args })
    if (channel === "mako:move-depart") return encodeRuntimeValue(await this.depart())
    throw new Error(`no ${channel} in this test`)
  }

  departs(): number {
    return this.calls.filter((call) => call.channel === "mako:move-depart").length
  }
}

/** The account's return steps as a Mac's `CloudAccount` asks them: a 409 with the record answers with the record. */
function accountOf(cloud: Cloud, device: string | undefined): CloudReturnSteps {
  const ask = async (move: string, step: Step): Promise<ReturnState> => {
    const verdict = cloud.step(move, step)
    if (verdict.kind === "refused") throw new Error(verdict.reason)
    return verdict.record
  }
  return {
    deviceId: async () => device,
    beginReturn: (_threadId, move) => ask(move, { step: "begin", by: device ?? randomUUID() }),
    releaseReturn: (_threadId, move, departure) => ask(move, { step: "release", departure }),
    cancelReturn: (_threadId, move, reason) => ask(move, { step: "cancel", reason }),
    archiveReturn: (_threadId, move) => ask(move, { step: "archive" }),
    returnState: async (_threadId, move) => cloud.records.get(move),
  }
}

/** One device's archives: its plans kept as text, as a file or a page's storage keeps them, which outlive it. */
function device(cloud: Cloud, plans = new Map<string, string>()) {
  const id = randomUUID()
  const steps: CloudArchiveStep[] = []
  const make = () => new CloudArchiver({
    plans: {
      read: async (op) => plans.get(op),
      write: async (op, text) => void plans.set(op, text),
      list: async () => [...plans.keys()],
    },
    account: () => accountOf(cloud, id),
    callThread: (_threadId, channel, args) => cloud.callThread(channel, args),
    step: (step) => steps.push(step),
    log: { info: () => undefined, warn: () => undefined },
    self: "This device",
  })
  const plan = (op: string): CloudArchivePlan | undefined => {
    const text = plans.get(op)
    return text === undefined ? undefined : readCloudArchivePlan(text)
  }
  return { id, plans, steps, archiver: make(), fresh: make, plan }
}

/** A value as it crosses the wire: what the gateway's JSON carries. */
const wire = (value: ReturnState | { title: string; status: number; record?: ReturnState }): JsonValue => JSON.parse(JSON.stringify(value))

const at = new Date().toISOString()
/** A row of the account's list: a conversation the cloud Thread's machine runs. */
function row(fields: Partial<ListedSession> = {}): ListedSession {
  return { session: randomUUID(), thread: randomUUID(), conversation: randomUUID(), harness: "codex", state: "idle", folder: FOLDER, createdAt: at, activityAt: at, generation: 1, nativeId: "n-1", runsOn: { kind: "cloud", threadId: THREAD }, listedAt: at, ...fields }
}
const ROWS = [row(), row({ nativeId: undefined }), row({ capture: { path: "/codex/n-9.jsonl" } }), row({ runsOn: { kind: "cloud", threadId: "t-ffffffffffffffff" } })]
const INPUTS = listedArchiveInputs(ROWS, THREAD)

// The account's list says what the machine packs: the conversations whose harness started there, and their folder.
assert.deepEqual(INPUTS, { conversations: [ROWS[0]!.conversation], folder: FOLDER }, "one never started, one Mako there never opened and another Thread's are left out")

// Archived: begun to the archive, packed by its machine toward the asking device, released, then archived.
{
  const cloud = new Cloud()
  const d = device(cloud)
  const op = randomUUID()
  assert.deepEqual(await d.archiver.archive(THREAD, op, false, () => INPUTS), { kind: "archived", thread: THREAD })
  assert.deepEqual(d.steps.map((step) => step.kind), ["packing", "ending"])
  assert.deepEqual(DepartAskSchema.parse(cloud.calls[0]?.args), [{ move: op, folder: FOLDER, conversations: INPUTS.conversations, device: d.id }], "packed toward the device that asked")
  const record = cloud.records.get(op)
  assert.deepEqual([record?.phase, record?.phase === "archived" && record.by, record?.phase === "archived" && record.departure], ["archived", d.id, DEPARTURE], "archived by its word, with what its machine packed")
  assert.equal(d.plan(op)?.phase, "archived")
  assert.deepEqual(await d.archiver.archive(THREAD, op, false, () => INPUTS), { kind: "archived", thread: THREAD }, "asked again, the same")
  assert.equal(cloud.departs(), 1, "and nothing asked again")
}

// Refused mid-turn: the gateway's words with nothing begun; a machine whose turn just began cancels it, in the person's
// words, and the Thread goes on as it was. One that can't start offers to archive it anyway.
{
  const cloud = new Cloud()
  const d = device(cloud)
  cloud.busy = "This Thread is working. Archive it once its turn ends."
  const working = randomUUID()
  assert.deepEqual(await d.archiver.archive(THREAD, working, false, () => INPUTS), { kind: "refused", thread: THREAD, reason: "This Thread is working. Archive it once its turn ends." })
  assert.equal(cloud.records.has(working), false, "nothing begun")
  assert.equal(cloud.departs(), 0, "nor its machine asked")
  cloud.busy = undefined
  cloud.depart = async () => { throw new Error("A Thread goes back between turns: codex is answering.") }
  const busy = randomUUID()
  assert.deepEqual(await d.archiver.archive(THREAD, busy, false, () => INPUTS), { kind: "refused", thread: THREAD, reason: "This Thread is working (codex is answering). Archive it once its turn ends." }, "in the person's words")
  const cancelled = cloud.records.get(busy)
  assert.deepEqual([cancelled?.phase, cancelled?.phase === "cancelled" && cancelled.reason], ["cancelled", "This Thread is working (codex is answering). Archive it once its turn ends."], "cancelled: it goes on as it was, never released")
  assert.deepEqual([d.plan(busy)?.phase, d.plan(busy)?.reason], ["cancelled", "This Thread is working (codex is answering). Archive it once its turn ends."])
  assert.deepEqual(d.steps.map((step) => step.kind), ["packing", "packing"], "never ending")
  assert.deepEqual(await d.archiver.archive(THREAD, busy, false, () => INPUTS), { kind: "refused", thread: THREAD, reason: "This Thread is working (codex is answering). Archive it once its turn ends." }, "asked again under its ID, the same")
  cloud.depart = async () => { throw new Error("This Thread couldn't start in the cloud. Try again in a moment.") }
  assert.deepEqual(await d.archiver.archive(THREAD, randomUUID(), false, () => INPUTS), { kind: "refused", thread: THREAD, reason: "This Thread couldn't start in the cloud. Try again in a moment.", anyway: true })
  const departs = cloud.departs()
  const anyway = randomUUID()
  assert.deepEqual(await d.archiver.archive(THREAD, anyway, true, () => INPUTS), { kind: "archived", thread: THREAD })
  assert.equal(cloud.departs(), departs, "archived anyway, its machine isn't asked again")
  const kept = cloud.records.get(anyway)
  assert.deepEqual([kept?.phase, kept?.phase === "archived" && kept.departure], ["archived", undefined], "with nothing packed")
}

// A device that doesn't know what the machine runs can't ask it to pack: never archived without its checkout unasked.
{
  const cloud = new Cloud()
  const d = device(cloud)
  const op = randomUUID()
  assert.deepEqual(await d.archiver.archive(THREAD, op, false, () => ({ conversations: [], folder: undefined })), { kind: "refused", thread: THREAD, reason: "Mako can't tell yet what this Thread runs in the cloud, so its checkout can't be saved. Try again in a moment.", anyway: true })
  assert.equal(cloud.records.get(op)?.phase, "cancelled")
}

// Plans a stopped device left: `begun` before the cloud heard it, `begun` once it had, and `released` before the
// archive was heard. Each is settled when the device next starts, from what its plan kept; none left fenced.
{
  const cloud = new Cloud()
  const d = device(cloud)
  const plan = (op: string, phase: "begun" | "released"): CloudArchivePlan => ({ op, thread: THREAD, conversations: INPUTS.conversations, folder: FOLDER, device: d.id, anyway: false, phase, began: Date.now(), timings: {} })
  const unheard = randomUUID()
  d.plans.set(unheard, JSON.stringify(plan(unheard, "begun")))
  await d.fresh().settle()
  assert.equal(cloud.records.get(unheard)?.phase, "archived", "begun, then packed and archived")
  assert.equal(d.plan(unheard)?.phase, "archived")

  const other = new Cloud()
  const e = device(other)
  const heard = randomUUID()
  other.records.set(heard, { phase: "returning", move: heard, at: Date.now(), to: "archive", by: e.id })
  e.plans.set(heard, JSON.stringify({ ...plan(heard, "begun"), device: e.id }))
  await e.fresh().settle()
  assert.deepEqual([other.records.get(heard)?.phase, other.departs()], ["archived", 1], "its machine packed once, then archived")

  // Unheard as it ends: the plan stands released and the person reads why; the next start finishes it.
  const third = new Cloud()
  const f = device(third)
  const op = randomUUID()
  // The release is heard; the archive after it isn't.
  const judged = third.step.bind(third)
  let lost = 1
  third.step = (move, asked) => {
    if (asked.step === "archive" && lost-- > 0) throw new Error("the network is down")
    return judged(move, asked)
  }
  const first = await f.archiver.archive(THREAD, op, false, () => INPUTS)
  assert.equal(first.kind, "refused")
  assert.match(first.kind === "refused" ? first.reason : "", /^Mako couldn't hear the cloud: the network is down\. It stays as it was until Mako does/)
  assert.deepEqual([third.records.get(op)?.phase, f.plan(op)?.phase], ["released", "released"], "released, and not yet archived")
  await f.fresh().settle()
  assert.deepEqual([third.records.get(op)?.phase, f.plan(op)?.phase, third.departs()], ["archived", "archived", 1], "the next start archived it, its machine asked once")
}

// Asked twice while one runs: one archive, joined, whatever ID the second came with.
{
  const cloud = new Cloud()
  const d = device(cloud)
  let pack: (() => void) | undefined
  const packing = new Promise<void>((resolve) => (pack = resolve))
  cloud.depart = async () => {
    await packing
    return DEPARTURE
  }
  const op = randomUUID()
  const first = d.archiver.archive(THREAD, op, false, () => INPUTS)
  const second = d.archiver.archive(THREAD, randomUUID(), false, () => INPUTS)
  assert.equal(second, first, "the same run")
  await new Promise((resolve) => setTimeout(resolve, 10))
  pack?.()
  assert.deepEqual(await Promise.all([first, second]), [{ kind: "archived", thread: THREAD }, { kind: "archived", thread: THREAD }])
  assert.deepEqual([cloud.records.size, cloud.departs()], [1, 1], "one return, one departure")
}

// The browser's: the same procedure over the gateway's API with this browser's token, the machine called through the
// gateway as this browser's device, plans in the page's storage under its account.
{
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return storage.size
      },
      key: (index: number) => [...storage.keys()][index] ?? null,
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  })
  const account = randomUUID()
  const browser = randomUUID()
  let cloud = new Cloud()
  const asked: string[] = []
  const operations: Operation[] = []
  /** The gateway's REST routes for a return (`thread/routes.ts`), as `Gateway.rest` answers them. */
  const rest = async (method: "GET" | "POST", path: string, body?: ReturnRequest): Promise<JsonValue> => {
    asked.push(`${method} ${path}`)
    const [, threadId, move, step] = /^\/v1\/threads\/([^/]+)\/returns\/([^/]+)(?:\/(.+))?$/.exec(path) ?? []
    assert.equal(threadId, THREAD)
    if (!move) throw new GatewayError(404, "Not found", undefined)
    if (method === "GET") {
      const record = cloud.records.get(move)
      if (!record) throw new GatewayError(404, "This return wasn't begun", undefined, wire({ title: "This return wasn't begun", status: 404 }))
      return wire(record)
    }
    // Each body checked as the gateway checks it, then judged.
    const asking = (): Step => {
      if (step === "release") return { step: "release", departure: ReturnReleaseRequestSchema.parse(body).departure }
      if (step === "cancel") return { step: "cancel", reason: ReturnReasonRequestSchema.parse(body).reason }
      if (step === "archive") {
        z.object({}).strict().parse(body)
        return { step: "archive" }
      }
      ReturnBeginRequestSchema.parse(body)
      return { step: "begin", by: browser }
    }
    const verdict = cloud.step(move, asking())
    if (verdict.kind === "refused") throw new GatewayError(409, verdict.reason, undefined, wire({ title: verdict.reason, status: 409 }))
    if (verdict.kind === "past") throw new GatewayError(409, `This return is ${verdict.record.phase}`, undefined, wire({ title: `This return is ${verdict.record.phase}`, status: 409, record: verdict.record }))
    return wire(verdict.record)
  }
  /** The Thread's connection: each host call goes to its machine, which answers as a host does. */
  const session: ClientSession = {
    call: async (operation: Operation): Promise<Reply> => {
      operations.push(operation)
      const request = fromHostOperation(operation)
      assert.equal(request.kind, "call")
      if (request.kind !== "call") throw new Error("refused")
      try {
        return hostSuccess(operation.id, await cloud.callThread(request.channel, request.args))
      } catch (error) {
        return hostFailure(operation.id, operation.correlationId, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
    subscribe: () => { throw new Error("no subscriptions in this test") },
    watch: () => { throw new Error("no media in this test") },
  }
  const gateway: ArchiveGateway = { rest, session, connection: async () => ({ account: { id: account } }) }
  const kept = (op: string) => {
    const text = storage.get(`mako:web:archive:${account}:${op}`)
    return text === undefined ? undefined : readCloudArchivePlan(text)
  }

  const steps: string[] = []
  const op = randomUUID()
  assert.deepEqual(await archiveCloudThread(gateway, browser, THREAD, ROWS, { op, step: (step) => steps.push(step) }), { kind: "archived", thread: THREAD })
  assert.deepEqual(steps, ["packing", "ending"])
  assert.deepEqual(asked, [`POST /v1/threads/${THREAD}/returns/${op}`, `POST /v1/threads/${THREAD}/returns/${op}/release`, `POST /v1/threads/${THREAD}/returns/${op}/archive`])
  assert.deepEqual(DepartAskSchema.parse(cloud.calls[0]?.args), [{ move: op, folder: FOLDER, conversations: INPUTS.conversations, device: browser }], "packed toward this browser, from the account's list")
  assert.deepEqual([operations[0]?.target, operations[0]?.actor, operations[0]?.whenUnstarted], [{ kind: "thread", threadId: THREAD }, { kind: "client", client: "web", deviceId: browser }, "refuse"], "to the Thread, as this browser, refused at once if its machine can't start")
  const record = ReturnStateSchema.parse(cloud.records.get(op))
  assert.deepEqual([record.phase, record.phase === "archived" && record.by], ["archived", browser], "archived by this browser's word")
  assert.equal(kept(op)?.phase, "archived", "its plan in this page's storage")
  // Asked from another device under a new ID: the gateway answers with the archive it is (a 409 carrying the record).
  assert.deepEqual(await archiveCloudThread(gateway, browser, THREAD, ROWS), { kind: "archived", thread: THREAD }, "archived already")

  // Refused mid-turn through the gateway: the machine's refusal, in the person's words. A Thread not archived yet.
  cloud = new Cloud()
  cloud.depart = async () => { throw new Error("A Thread goes back between turns: claude is answering.") }
  const busy = randomUUID()
  assert.deepEqual(await archiveCloudThread(gateway, browser, THREAD, ROWS, { op: busy }), { kind: "refused", thread: THREAD, reason: "This Thread is working (claude is answering). Archive it once its turn ends." })
  assert.equal(cloud.records.get(busy)?.phase, "cancelled", "cancelled: it goes on as it was")
  const refused = randomUUID()
  cloud.busy = "This Thread is working. Archive it once its turn ends."
  assert.deepEqual(await archiveCloudThread(gateway, browser, THREAD, ROWS, { op: refused }), { kind: "refused", thread: THREAD, reason: "This Thread is working. Archive it once its turn ends." }, "the gateway's own refusal, as it said it")
  assert.equal(cloud.records.has(refused), false)
  cloud.busy = undefined

  // A page reloaded mid-archive: its plan, left released, is settled at the next start; a finished one long past is forgotten.
  cloud.depart = async () => DEPARTURE
  const reloaded = randomUUID()
  cloud.records.set(reloaded, { phase: "released", move: reloaded, at: Date.now(), departure: DEPARTURE, to: "archive", by: browser })
  storage.set(`mako:web:archive:${account}:${reloaded}`, JSON.stringify({ op: reloaded, thread: THREAD, conversations: INPUTS.conversations, folder: FOLDER, device: browser, anyway: false, phase: "released", began: Date.now(), timings: {} }))
  const old = randomUUID()
  storage.set(`mako:web:archive:${account}:${old}`, JSON.stringify({ ...kept(busy), op: old, began: Date.now() - 8 * 24 * 60 * 60 * 1000 }))
  const someoneElse = `mako:web:archive:${randomUUID()}:${randomUUID()}`
  storage.set(someoneElse, JSON.stringify({ ...kept(reloaded), phase: "begun" }))
  await settleArchives(gateway, browser)
  assert.deepEqual([cloud.records.get(reloaded)?.phase, kept(reloaded)?.phase], ["archived", "archived"], "settled at the next start")
  assert.equal(kept(old), undefined, "a finished plan a week old is forgotten")
  assert.equal(kept(busy)?.phase, "cancelled", "a recent one is kept, to answer the same if asked again")
  assert.ok(storage.has(someoneElse), "another account's plan is left for its own sign-in")
}

console.log("PASS: a cloud Thread is archived by the one procedure a Mac and a browser both run: packed toward the device that asked, released, archived; refused while it works in the gateway's or the person's words, the Thread left as it was, and offered anyway when its machine can't start; a plan left begun or released is settled at the next start; two asks join one run; and from a browser, over the gateway's API and its Thread connection, with its plans in the page's storage")
