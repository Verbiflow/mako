import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { ContinueState } from "@mako/protocol/continues"
import { quietDevice, type ListedSession } from "@mako/protocol/thread-listing"
import { carryContinue, continuePath, continueReadings, continueTimings, ContinueRecorder, describeContinue, type ContinueAnswer, type ContinueAsk } from "@mako/host/contracts/cloud-continues"
import { listedContinueChoice } from "@mako/host/contracts/listed-conversations"
import type { ThreadContinueStep } from "@mako/host/contracts/cloud-threads"
import { CloudContinues } from "@mako/host/conversations/cloud-continues"
import type { CloudAccount } from "@mako/host/usage/index"

/**
 * Continue in the cloud as a device carries a press (`carryContinue`, the one loop a browser and a Mac's host share),
 * what its Diagnostics read of it (`ContinueRecorder`, `describeContinue`), and a Mac's host pressing it for another
 * device's Thread (`CloudContinues`): a lost answer pressed again under the same op, never read as a press that never
 * landed; a refusal ends it in the account's words; every step said once, in order; a second press of the same op is
 * the same continue.
 */
const mac = randomUUID()
const by = randomUUID()
const thread = randomUUID()
const session = randomUUID()
const conversation = randomUUID()
const op = randomUUID()
const cloudThread = "t-0123456789abcdef"
const at = new Date(1_000).toISOString()

function state(phase: ContinueState["phase"], extra: Partial<ContinueState> = {}): ContinueState {
  return {
    op,
    thread,
    threadTitle: "Retry failed charges",
    from: mac,
    by,
    cloudThread,
    folder: "/Users/ana/worktrees/retry",
    repository: { url: "https://github.com/ana/payments", branch: "mako/retry" },
    sessions: [{ session, conversation, harness: "codex", nativeId: "n-1", generation: 2, folder: "/Users/ana/worktrees/retry" }],
    waiting: [],
    phase,
    at,
    changedAt: at,
    ...extra,
  }
}

/** An account that answers each ask in turn, and keeps what it was asked. */
function scripted(answers: Array<ContinueAnswer | Error>) {
  const asked: Array<Parameters<ContinueAsk>[0]> = []
  const ask: ContinueAsk = async (request) => {
    asked.push(request)
    const next = answers.shift()
    if (!next) throw new Error(`asked more than was scripted: ${request.method} ${request.path}`)
    if (next instanceof Error) throw next
    return next
  }
  return { ask, asked }
}

const waits: number[] = []
const wait = async (ms: number) => {
  waits.push(ms)
}
let clock = 10_000
const now = () => (clock += 250)

// A press whose answer was lost is pressed again, not read: reading would find nothing of a press that never landed.
{
  const account = scripted([
    { status: 502, body: { title: "Bad gateway" } },
    new Error("The network connection was lost."),
    { status: 202, body: state("making") },
    { status: 200, body: state("arriving", { machine: "mako-machine-7f3a" }) },
    { status: 200, body: state("continued", { machine: "mako-machine-7f3a" }) },
  ])
  const recorder = new ContinueRecorder(now)
  recorder.pressed(op, session, { thread, title: "Retry failed charges" })
  const end = await carryContinue({ session, op, ask: account.ask, wait, now, heard: (heard) => recorder.heard(op, heard), holdMs: 12_000 })
  assert.equal(end.kind, "continued")
  assert.deepEqual(account.asked.map((each) => each.method), ["POST", "POST", "POST", "GET", "GET"])
  assert.deepEqual(account.asked.map((each) => each.path), [continuePath(session, op), continuePath(session, op), continuePath(session, op), `${continuePath(session, op)}?wait=12000`, `${continuePath(session, op)}?wait=12000`])
  assert.deepEqual(account.asked.map((each) => each.first), [true, false, false, false, false])
  assert.equal(new Set(account.asked.map((each) => each.correlationId)).size, 5, "each ask goes under a correlation ID of its own")
  assert.deepEqual(waits.splice(0), [2_000, 5_000], "asked again a little later each time an answer was lost")

  const [reading] = recorder.readings()
  assert.ok(reading)
  assert.equal(reading.phase, "continued")
  assert.equal(reading.cloudThread, cloudThread)
  assert.equal(reading.machine, "mako-machine-7f3a")
  assert.deepEqual(reading.asks.map((each) => each.outcome), ["lost", "lost", "making", "arriving", "continued"])
  assert.deepEqual(continueTimings(reading).map(([phase]) => phase), ["asking", "making", "arriving"])
  const line = describeContinue(reading)
  assert.match(line, new RegExp(`^continued · op ${op} · to ${cloudThread} on mako-machine-7f3a · asking `))
  assert.ok(line.includes(account.asked.at(-1)!.correlationId), "the last ask's correlation ID, which the account's log is read by")
}

// A follow lost after the press is landed is read again, not pressed: the account has it.
{
  const account = scripted([{ status: 202, body: state("making") }, { status: 503, body: { title: "Unavailable" } }, { status: 200, body: state("continued") }])
  assert.equal((await carryContinue({ session, op, ask: account.ask, wait, now })).kind, "continued")
  assert.deepEqual(account.asked.map((each) => each.method), ["POST", "GET", "GET"])
  assert.match(account.asked[1]!.path, /\?wait=20000$/, "held open the account's longest when the asker has time")
  waits.splice(0)
}

// A refusal ends it in the account's words; one that failed there ends with its reason.
{
  const refused = scripted([{ status: 409, body: { title: "It can't continue in the cloud", detail: "Its branch isn't on GitHub." } }])
  assert.deepEqual(await carryContinue({ session, op, ask: refused.ask, wait, now }), { kind: "failed", reason: "It can't continue in the cloud: Its branch isn't on GitHub." })
  const failed = scripted([{ status: 202, body: state("failed", { reason: "The machine couldn't clone mako/retry." }) }])
  const end = await carryContinue({ session, op, ask: failed.ask, wait, now })
  assert.equal(end.kind, "failed")
  assert.equal(end.kind === "failed" && end.reason, "The machine couldn't clone mako/retry.")
  // An answer that isn't a continue is lost, and asked again; put away meanwhile, the press stops.
  const strange = scripted([{ status: 200, body: { nonsense: true } }])
  assert.deepEqual(await carryContinue({ session, op, ask: strange.ask, wait, now, goOn: () => false }), { kind: "stopped" })
  waits.splice(0)
}

// What Diagnostics read: the list's word moves a reading on, never back from an end; a continue pressed elsewhere is read from the list alone.
{
  const recorder = new ContinueRecorder(now)
  recorder.pressed(op, session, { thread })
  recorder.heard(op, { at: now(), method: "POST", correlationId: randomUUID(), ms: 120, asked: { kind: "state", state: state("continued") } })
  const elsewhere = randomUUID()
  const rows = [
    { session, thread, continued: { op, phase: "arriving" as const, from: mac, by, cloudThread, at } },
    { session: randomUUID(), thread: randomUUID(), threadTitle: "Ledger export", continued: { op: elsewhere, phase: "failed" as const, from: mac, by, cloudThread, at, reason: "No machine was free." } },
  ]
  const readings = continueReadings(recorder.readings(), rows)
  assert.deepEqual(readings.map((each) => [each.op, each.phase, each.here]), [[op, "continued", true], [elsewhere, "failed", false]])
  assert.match(describeContinue(readings[1]!), /^failed \(pressed elsewhere\) · .* · No machine was free\.$/)
}

const row: ListedSession = {
  session,
  thread,
  conversation,
  harness: "codex",
  title: "Retry failed charges",
  threadTitle: "Retry failed charges",
  state: "idle",
  generation: 2,
  runsOn: { kind: "device", deviceId: mac },
  createdAt: at,
  activityAt: at,
  listedAt: at,
  folder: "/Users/ana/worktrees/retry",
  nativeId: "n-1",
  worktree: { branch: "mako/retry" },
  repository: { url: "https://github.com/ana/payments", branch: "mako/retry" },
}

// A quiet device's row as a Mac's windows list it: whether it may continue, by the one rule, and the continue the account carries.
{
  assert.deepEqual(listedContinueChoice(row, [row], [quietDevice(mac, at, true)]), {})
  assert.deepEqual(listedContinueChoice(row, [row], [quietDevice(mac, at, false)]), { refusal: "older-device" })
  assert.deepEqual(listedContinueChoice({ ...row, state: "working" }, [{ ...row, state: "working" }], [quietDevice(mac, at, true)]), { refusal: "working" })
  const continued = { op, phase: "making" as const, from: mac, by, cloudThread, at }
  assert.deepEqual(listedContinueChoice({ ...row, continued }, [{ ...row, continued }], [quietDevice(mac, at, true)]), { refusal: "continuing", continued })
}

// A Mac's host pressing it for another device's Thread: its steps said once, in order, a second press of its op joined.
{
  const asks: string[] = []
  const answers: ContinueAnswer[] = [
    { status: 200, body: { offer: true, thread, from: mac, since: at, folder: row.folder, repository: row.repository, sessions: [{ session, harness: "codex", freshness: { behind: false } }] } },
    { status: 202, body: state("making") },
    { status: 200, body: state("making") },
    { status: 200, body: state("arriving") },
    { status: 200, body: state("continued", { machine: "mako-machine-7f3a" }) },
  ]
  const account: Pick<CloudAccount, "askContinue"> = {
    askContinue: async (route, method, at, correlationId) => {
      asks.push(`${route} ${method} ${at} ${correlationId.length}`)
      return answers.shift()!
    },
  }
  const steps: ThreadContinueStep[] = []
  const continues = new CloudContinues({
    account: () => account,
    listed: (id) => (id === conversation ? row : undefined),
    rows: () => [row],
    waiting: () => 2,
    step: (id, stepOp, step) => {
      assert.equal(id, conversation)
      assert.equal(stepOp, op)
      steps.push(step)
    },
    now,
    wait,
  })
  const offered = await continues.offer(conversation)
  assert.equal(offered.offer.offer, true)
  assert.equal(offered.waiting, 2)
  const [first, again] = await Promise.all([continues.press(conversation, op), continues.press(conversation, op)])
  assert.deepEqual(first, { kind: "continued", cloudThread })
  assert.deepEqual(again, first, "the same op is the same continue")
  assert.deepEqual(asks.map((each) => each.split(" ").slice(0, 2).join(" ")), ["continues.offer GET", "continues.press POST", "continues.follow GET", "continues.follow GET", "continues.follow GET"])
  assert.ok(asks.every((each) => each.endsWith(" 36")), "each ask under a correlation ID the host keeps")
  assert.ok(asks.slice(2).every((each) => each.includes("?wait=12000")), "held open within the host's own time for a request")
  assert.deepEqual(steps, [{ kind: "asking" }, { kind: "making" }, { kind: "arriving" }, { kind: "continued", cloudThread }])
  const [reading] = continues.readings()
  assert.equal(reading?.machine, "mako-machine-7f3a")
  assert.equal(reading?.here, true)
  await assert.rejects(continues.press(randomUUID(), randomUUID()), /isn't in your account's list/)
}

// Signed out, the host says so rather than pressing anything.
{
  const continues = new CloudContinues({ account: () => undefined, listed: () => row, rows: () => [row], waiting: () => 0, step: () => {} })
  await assert.rejects(continues.offer(conversation), /isn't signed in/)
}

console.log("cloud continues: ok")
