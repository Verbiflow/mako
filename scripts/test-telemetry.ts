/**
 * Telemetry against a fake cloud: what a batch holds, when it goes, what the
 * person's choice stops, and that nothing a person wrote, or where they keep
 * it, ever reaches the request.
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "../electron/live-conversations.ts"
import { providerHost } from "../electron/providers/index.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import type { LiveDriverEvent } from "../electron/shared.ts"
import type { LiveRequest, LiveSnapshot } from "../electron/contracts/live-conversations.ts"
import type { NativeAgent, NativeAgentRoster } from "../electron/contracts/native-agents.ts"
import type { LiveSessionState } from "../electron/contracts/providers-acp.ts"
import { PrincipalIdSchema } from "../electron/contracts/thread-identity.ts"
import type { TelemetryBatch } from "../electron/contracts/telemetry.ts"
import type { CrashReport } from "../electron/crash.ts"
import { HostTelemetry, type HostTelemetrySources } from "../electron/host-telemetry.ts"
import { hashMachineId } from "../electron/machine-id.ts"
import { Telemetry, scrub, telemetryOff, type TelemetryOptions } from "../electron/telemetry.ts"
import { errorReported, harnessInventory, turnChanges, turnCompleted, unknownSince } from "../electron/telemetry-events.ts"

const scratch = await mkdtemp(join(tmpdir(), "mako-telemetry-"))
after(() => rm(scratch, { recursive: true, force: true }))

/** Values that must never leave the machine: if one reaches a request, the boundary leaked. */
const CANARY = {
  prompt: "CANARY-PROMPT refactor the billing module before Friday",
  title: "CANARY-TITLE billing",
  cwd: "/Users/ada-canary/src/secret-repo",
  email: "ada.canary@example.com",
  token: "Bearer mako_dc_CANARYCANARYCANARYCANARY",
  attachment: "/Users/ada-canary/Desktop/contract.pdf",
}

interface Sent {
  url: string
  authorization: string | null
  batch: TelemetryBatch
  text: string
}

/** The cloud's `/v1/telemetry`, answering from a script of responses; 202 when the script runs out. */
function fakeCloud() {
  const sent: Sent[] = []
  const answers: Array<() => Response> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const text = String(init?.body)
    const batch: TelemetryBatch = JSON.parse(text)
    sent.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), batch, text })
    return (answers.shift() ?? (() => Response.json({ accepted: batch.events.length, dropped: 0 }, { status: 202 })))()
  }
  return { sent, answers, fetch, names: () => sent.flatMap((request) => request.batch.events.map((event) => event.name)) }
}

let files = 0
function clock(start = Date.parse("2026-10-07T12:00:00Z")) {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

async function open(overrides: Partial<TelemetryOptions> = {}) {
  const cloud = fakeCloud()
  const time = clock()
  const file = join(scratch, `telemetry-${++files}.json`)
  const telemetry = await Telemetry.open({
    file,
    cloud: "https://cloud.example.test",
    app: { version: "0.4.0", build: "abc123", distribution: "signed", os: "macOS", osVersion: "26.1", arch: "arm64" },
    fetch: cloud.fetch,
    now: time.now,
    ...overrides,
  })
  return { telemetry, cloud, time, file }
}

const started = { firstRun: false, signedIn: false }

test("an install makes its ID once, with both kinds on, in a file only its user reads", async () => {
  const { telemetry, file } = await open()
  assert.equal(telemetry.firstRun, true)
  assert.deepEqual(telemetry.state(), { usage: true, errors: true })
  assert.match(telemetry.install, /^[0-9a-f-]{36}$/)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const again = await Telemetry.open({ file, cloud: "https://cloud.example.test", app: { version: "0.4.0", distribution: "signed", os: "macOS", arch: "arm64" } })
  assert.equal(again.firstRun, false)
  assert.equal(again.install, telemetry.install)
})

test("events wait for a batch, which goes to the cloud's telemetry route with what the person allows", async () => {
  const { telemetry, cloud } = await open()
  telemetry.record("app.started", { startupMs: 812, firstRun: true, signedIn: false })
  telemetry.record("feature.used", { feature: "thread.forked", harness: "claude" })
  assert.equal(cloud.sent.length, 0, "recording sends nothing by itself")
  await telemetry.flush()
  assert.equal(cloud.sent.length, 1)
  const [request] = cloud.sent
  assert.ok(request)
  assert.equal(request.url, "https://cloud.example.test/v1/telemetry")
  assert.equal(request.batch.install, telemetry.install)
  assert.deepEqual(request.batch.consent, { product: true, diagnostics: true })
  assert.deepEqual(request.batch.app, { version: "0.4.0", build: "abc123", distribution: "signed", os: "macOS", osVersion: "26.1", arch: "arm64" })
  assert.deepEqual(cloud.names(), ["app.started", "feature.used"])
  assert.equal(new Set(request.batch.events.map((event) => event.id)).size, 2, "each event has its own ID, for the cloud to drop a repeat")
  await telemetry.flush()
  assert.equal(cloud.sent.length, 1, "an empty queue sends nothing")
})

test("every install on a computer names it the same way, read once and only when a batch goes", async () => {
  let reads = 0
  const machine = async () => (reads++, hashMachineId("4C4C4544-0042-3510-8051-B7C04F4E3432"))
  const first = await open({ machine })
  const second = await open({ machine })
  assert.equal(reads, 0, "nothing is read before there is something to send")
  for (const { telemetry } of [first, second]) {
    telemetry.record("app.started", started)
    telemetry.record("app.started", started)
    await telemetry.flush()
    telemetry.record("app.started", started)
    await telemetry.flush()
  }
  assert.equal(reads, 2, "once per install, not per batch")
  const sent = [...first.cloud.sent, ...second.cloud.sent]
  assert.equal(new Set(sent.map((request) => request.batch.install)).size, 2, "each install keeps its own ID")
  assert.deepEqual(new Set(sent.map((request) => request.batch.machine)), new Set([hashMachineId("4c4c4544-0042-3510-8051-b7c04f4e3432")]))
  assert.match(sent[0]!.batch.machine!, /^[0-9a-f]{32}$/)
  assert.ok(!sent[0]!.text.toLowerCase().includes("4c4c4544"), "the hardware ID itself never leaves")

  const unknown = await open({ machine: async () => undefined })
  unknown.telemetry.record("app.started", started)
  await unknown.telemetry.flush()
  assert.equal(unknown.cloud.sent[0]?.batch.machine, undefined)
})

test("a signed-in computer links its history to the account once per account, and again only for another account", async () => {
  const { telemetry, cloud, time, file } = await open()
  let account: string | undefined
  const { host: hostTelemetry } = host(telemetry, time, { account: async () => account })
  await hostTelemetry.started(500)
  account = "2c4b0d9e-7f1a-4d0e-9a51-3b8f6a1c2d40"
  await hostTelemetry.signedIn()
  await hostTelemetry.signedIn()
  await hostTelemetry.sweep()
  await telemetry.flush()
  assert.deepEqual(cloud.names(), ["app.started", "feature.used", "account.linked", "feature.used", "app.heartbeat"])
  assert.deepEqual(cloud.sent[0]?.batch.events.find((event) => event.name === "account.linked")?.props, {})
  assert.ok(!(await readFile(file, "utf8")).includes(account), "the file keeps a hash, not the account")

  const reopened = await Telemetry.open({ file, cloud: "https://cloud.example.test", app: { version: "0.4.0", distribution: "signed", os: "macOS", arch: "arm64" }, fetch: cloud.fetch })
  const { host: again } = host(reopened, time, { account: async () => account })
  await again.started(500)
  account = "9d0e3f6a-1b2c-4d5e-8f70-112233445566"
  await again.signedIn()
  await reopened.flush()
  assert.deepEqual(cloud.names().slice(5), ["app.started", "feature.used", "account.linked"], "a restart doesn't link again; another account does")
})

test("fifty events send at once; a batch holds at most a hundred", async () => {
  const { telemetry, cloud } = await open()
  for (let index = 0; index < 49; index++) telemetry.record("app.started", started)
  assert.equal(cloud.sent.length, 0)
  telemetry.record("app.started", started)
  await telemetry.flush()
  assert.equal(cloud.sent.length, 1)
  assert.equal(cloud.sent[0]?.batch.events.length, 50)
  for (let index = 0; index < 150; index++) telemetry.record("app.started", started)
  await telemetry.flush()
  assert.deepEqual(cloud.sent.slice(1).map((request) => request.batch.events.length).sort(), [100, 50].sort())
})

test("turning a kind off drops what of it was waiting and records no more; both off, no request is made", async () => {
  const { telemetry, cloud, file } = await open()
  telemetry.record("app.started", started)
  telemetry.report("native.unknown", { harness: "codex", kind: "item/new", reason: "unknown", count: 1 })
  assert.deepEqual(await telemetry.choose({ usage: false }), { usage: false, errors: true })
  telemetry.record("feature.used", { feature: "turn.rewound" })
  await telemetry.flush()
  assert.deepEqual(cloud.names(), ["native.unknown"])
  assert.deepEqual(cloud.sent[0]?.batch.consent, { product: false, diagnostics: true })
  await telemetry.choose({ errors: false })
  telemetry.record("app.started", started)
  telemetry.report("native.unknown", { harness: "codex", kind: "item/new", reason: "unknown", count: 1 })
  await telemetry.flush()
  await telemetry.close()
  assert.equal(cloud.sent.length, 1, "nothing goes out with both off")
  const reopened = await Telemetry.open({ file, cloud: "https://cloud.example.test", app: { version: "0.4.0", distribution: "signed", os: "macOS", arch: "arm64" } })
  assert.deepEqual(reopened.state(), { usage: false, errors: false }, "the choice survives a restart")
})

test("DO_NOT_TRACK, MAKO_TELEMETRY=off and a fixture desk send nothing and write nothing", async () => {
  assert.equal(telemetryOff({ DO_NOT_TRACK: "1" }, false), "environment")
  assert.equal(telemetryOff({ MAKO_TELEMETRY: "off" }, false), "environment")
  assert.equal(telemetryOff({}, true), "fixture")
  assert.equal(telemetryOff({ MAKO_TELEMETRY: "on" }, true), undefined)
  assert.equal(telemetryOff({}, false), undefined)
  for (const off of ["environment", "fixture"] as const) {
    const { telemetry, cloud, file } = await open({ off })
    assert.equal(telemetry.state().off, off)
    telemetry.record("app.started", started)
    await telemetry.flush()
    assert.equal(cloud.sent.length, 0)
    await assert.rejects(readFile(file), { code: "ENOENT" }, "no install ID is kept")
  }
  const { telemetry, cloud } = await open({ cloud: undefined })
  assert.equal(telemetry.state().off, "no-cloud")
  telemetry.record("app.started", started)
  await telemetry.flush()
  assert.equal(cloud.sent.length, 0)
})

test("a cloud that fails or limits keeps the batch for later; one that pauses telemetry drops it", async () => {
  const { telemetry, cloud, time } = await open()
  cloud.answers.push(() => new Response(null, { status: 503 }))
  telemetry.record("app.started", started)
  await telemetry.flush()
  await telemetry.flush()
  assert.equal(cloud.sent.length, 1, "it waits before trying again")
  time.advance(31_000)
  cloud.answers.push(() => new Response(null, { status: 429, headers: { "retry-after": "120" } }))
  await telemetry.flush()
  assert.equal(cloud.sent.length, 2)
  time.advance(60_000)
  await telemetry.flush()
  assert.equal(cloud.sent.length, 2, "retry-after is honoured")
  time.advance(61_000)
  await telemetry.flush()
  assert.equal(cloud.sent.length, 3)
  assert.equal(cloud.sent[2]?.batch.events[0]?.id, cloud.sent[0]?.batch.events[0]?.id, "the same event, so the cloud can drop a repeat")
  cloud.answers.push(() => Response.json({ accepted: 0, dropped: 1, pauseSeconds: 3600 }, { status: 202 }))
  telemetry.record("app.started", started)
  await telemetry.flush()
  telemetry.record("app.started", started)
  time.advance(30 * 60_000)
  await telemetry.flush()
  assert.equal(cloud.sent.length, 4, "nothing goes during the pause")
  time.advance(31 * 60_000)
  await telemetry.flush()
  assert.equal(cloud.sent.length, 5)
})

test("a refused batch isn't sent again, and a signed-in Mac's batch carries its connection token", async () => {
  const { telemetry, cloud } = await open({ token: async () => "connection-token" })
  cloud.answers.push(() => new Response(null, { status: 400 }))
  telemetry.record("app.started", started)
  await telemetry.flush()
  await telemetry.flush()
  assert.equal(cloud.sent.length, 1)
  assert.equal(cloud.sent[0]?.authorization, "Bearer connection-token")
  const anonymous = await open({ token: async () => { throw new Error("signed out") } })
  anonymous.telemetry.record("app.started", started)
  await anonymous.telemetry.flush()
  assert.equal(anonymous.cloud.sent[0]?.authorization, null, "a token that can't be had leaves the batch anonymous")
})

test("while the cloud is down the queue keeps the newest thousand events", async () => {
  const { telemetry, cloud, time } = await open()
  cloud.answers.push(() => new Response(null, { status: 503 }))
  telemetry.record("feature.used", { feature: "turn.rewound" })
  await telemetry.flush()
  for (let index = 0; index < 1_200; index++) telemetry.record("app.heartbeat", { harnesses: [], threads: index, signedIn: false })
  assert.equal(cloud.sent.length, 1, "a full queue doesn't send into an outage")
  time.advance(31_000)
  await telemetry.flush()
  const events = cloud.sent.slice(1).flatMap((request) => request.batch.events)
  assert.equal(events.length, 1_000)
  assert.deepEqual(events[0]?.props, { harnesses: [], threads: 200, signedIn: false })
  assert.deepEqual(events.at(-1)?.props, { harnesses: [], threads: 1_199, signedIn: false })
})

function session(overrides: Partial<LiveSessionState> = {}): LiveSessionState {
  return {
    id: "conversation-1",
    harness: "claude",
    cwd: CANARY.cwd,
    title: CANARY.title,
    status: "ready",
    connection: "connected",
    modes: [{ id: "acceptEdits", name: "Accept edits", access: "edits" }, { id: "plan", name: "Plan", access: "plan" }],
    currentMode: "acceptEdits",
    configOptions: [{ id: "effort", label: "Effort", kind: "select", role: "reasoning", current: "medium", values: [{ value: "medium", label: "Medium" }, { value: "high", label: "High" }] }],
    settings: { model: "claude-opus-4-5" },
    ...overrides,
  }
}

function request(overrides: Partial<LiveRequest> = {}): LiveRequest {
  return {
    id: "request-1",
    text: CANARY.prompt,
    displayText: CANARY.prompt,
    attachments: [{ name: "contract.pdf", mimeType: "application/pdf", path: CANARY.attachment }],
    status: "queued",
    actor: { kind: "person", principal: PrincipalIdSchema.parse("6f9c2c43-1b7e-4b8e-9f43-2f0f0b6f1a11") },
    tuning: { options: { effort: "high" } },
    ...overrides,
  }
}

function snapshot(requests: LiveRequest[], overrides: { session?: LiveSessionState; nativeAgents?: NativeAgentRoster } = {}): LiveSnapshot {
  return { session: session(), createdAt: 1, revision: 1, blocks: [], base: null, permissions: [], requests, ...overrides }
}

/** A subagent of `requestId`, titled by the agent with the person's words. */
function subagent(nativeId: string, requestId: string): NativeAgent {
  return { nativeId, title: CANARY.title, state: { kind: "completed" }, bindingId: "binding-1", provider: "claude", requestId, observedAt: 1 }
}

function host(telemetry: Telemetry, time: { now: () => number }, overrides: Partial<HostTelemetrySources> = {}) {
  let crashes: CrashReport[] = []
  const sources: HostTelemetrySources = {
    crashesAfter: (id) => crashes.filter((crash) => crash.id > id),
    crashIdAt: (at) => new Date(at).toISOString().replace(/[:.]/g, "-"),
    unknownKinds: () => [],
    account: async () => undefined,
    attended: () => true,
    inventory: async () => ({ harnesses: ["claude", "codex"], runtimes: { claude: { installed: "2.0.14 (Claude Code)" } }, threads: 12 }),
    now: time.now,
    ...overrides,
  }
  return { host: new HostTelemetry(telemetry, sources), crash: (report: CrashReport) => (crashes = [...crashes, report]) }
}

test("a turn is reported when it reaches the harness and when it ends, by its harness, model, effort, mode and spend", async () => {
  const { telemetry, cloud, time } = await open()
  const { host: hostTelemetry } = host(telemetry, time)
  const queued = snapshot([request()])
  const dispatching = snapshot([request({ status: "dispatching" })])
  hostTelemetry.turns(queued, dispatching)
  time.advance(42_000)
  const completed = snapshot([request({
    status: "completed",
    spend: { provider: "claude", model: "claude-opus-4-5", at: time.now(), tokens: { input: 1200, cacheRead: 30_000, cacheWrite: 800, output: 950, reasoning: 300 }, cost: 0.42 },
  })], { nativeAgents: { agents: [subagent("agent-1", "request-1"), subagent("agent-2", "request-0")], limited: false } })
  hostTelemetry.turns(dispatching, completed)
  hostTelemetry.turns(completed, completed)
  await telemetry.flush()
  const events = cloud.sent.flatMap((sent) => sent.batch.events)
  assert.deepEqual(events.map((event) => [event.name, event.props]), [
    ["turn.started", { harness: "claude", model: "claude-opus-4-5", effort: "high", mode: "acceptEdits", access: "edits", attachments: 1, actor: "person", continuation: false }],
    ["turn.completed", {
      harness: "claude", model: "claude-opus-4-5", effort: "high", mode: "acceptEdits", access: "edits",
      status: "completed", durationMs: 42_000,
      tokens: { input: 1200, cacheRead: 30_000, cacheWrite: 800, output: 950, reasoning: 300 }, costUsd: 0.42,
      usage: "complete", subagents: 1,
    }],
  ])
})

test("the conversation owner reports a real turn through its journal commits", async () => {
  const { telemetry, cloud } = await open()
  const { host: hostTelemetry } = host(telemetry, { now: Date.now })
  const root = await mkdtemp(join(scratch, "live-"))
  let emit: ((event: LiveDriverEvent) => void) | undefined
  const ready = (id: string, patch: Partial<LiveSessionState> = {}): LiveSessionState =>
    session({ id, cwd: root, nativeId: "native-1", ...patch })
  const prototype = providerHost.liveDrivers.list()[0]!
  const driver: ProviderLiveDriver = {
    ...prototype,
    provider: "claude",
    available: () => true,
    async start(_cwd, options) {
      emit = options.emit
      return ready(options.conversationId)
    },
    async prompt(id, _text, _attachments, _settings, dispatch) {
      dispatch.report({ kind: "accepted", source: "native-response" })
      emit?.({ type: "live-session", session: ready(id, { status: "running" }) })
      setTimeout(() => emit?.({ type: "live-session", session: ready(id, { usage: { tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 20 } } }) }), 20)
    },
    async close() {},
  }
  const owner = new LiveConversations({ root, appPath: root, driver: () => driver, history: async () => null, emit: () => {}, turns: hostTelemetry.turns })
  const id = randomUUID()
  try {
    await owner.start("claude", root, { conversationId: id })
    owner.submit(id, randomUUID(), CANARY.prompt)
    const deadline = Date.now() + 3_000
    while (owner.snapshot(id)?.requests[0]?.status !== "completed" && Date.now() < deadline) await delay(5)
  } finally {
    await owner.close(id).catch(() => {})
    await owner.stop()
  }
  await telemetry.flush()
  const events = cloud.sent.flatMap((request) => request.batch.events)
  assert.deepEqual(events.map((event) => event.name), ["turn.started", "turn.completed"])
  const completed = events[1]?.props
  assert.ok(completed && "durationMs" in completed && completed.durationMs !== undefined && completed.durationMs >= 20)
  assert.deepEqual({ ...completed, durationMs: 0 }, {
    harness: "claude", model: "claude-opus-4-5", effort: "medium", mode: "acceptEdits", access: "edits",
    status: "completed", durationMs: 0, tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 20 }, usage: "complete", subagents: 0,
  })
  assert.ok(!cloud.sent.some((request) => request.text.includes("CANARY")), "the prompt stays home")
})

test("a turn that fails or is cut short says how; one with no reading says so", () => {
  const before = snapshot([request({ status: "dispatching" }), request({ id: "request-2", status: "queued" })])
  const afterwards = snapshot([
    request({ status: "interrupted", failure: "network", interruption: { reason: "connection-lost", at: 1 }, spend: { provider: "claude", at: 1, tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, unrecorded: "cost" } }),
    request({ id: "request-2", status: "failed", failure: "auth" }),
  ])
  const { started, settled } = turnChanges(before, afterwards)
  assert.equal(started.length, 0)
  assert.deepEqual(settled.map((entry) => entry.id), ["request-1", "request-2"])
  assert.deepEqual(turnChanges(afterwards, afterwards), { started: [], settled: [] })
  const [dropped, failed] = settled.map((entry) => turnCompleted(afterwards, entry, undefined))
  assert.deepEqual([dropped?.status, dropped?.failure, dropped?.interruption, dropped?.usage], ["interrupted", "network", "connection-lost", "partial"])
  assert.deepEqual([failed?.status, failed?.failure, failed?.usage, failed?.durationMs], ["failed", "auth", "none", undefined])
})

test("nothing a person wrote, or where they keep it, reaches the request", async () => {
  const { telemetry, cloud, time } = await open()
  const { host: hostTelemetry, crash } = host(telemetry, time)
  await hostTelemetry.started(900)
  hostTelemetry.threadCreated({ harness: "claude", origin: "new", worktree: true, purpose: "setup" })
  hostTelemetry.turns(snapshot([request()]), snapshot([request({ status: "dispatching" })]))
  hostTelemetry.turns(snapshot([request({ status: "dispatching" })]), snapshot([request({ status: "failed", error: `${CANARY.prompt} at ${CANARY.cwd}` })]))
  // A model or mode that isn't an identifier is left out rather than sent.
  hostTelemetry.turns(snapshot([]), snapshot([request({ id: "request-3", status: "dispatching", tuning: { model: CANARY.prompt } })], { session: session({ currentMode: CANARY.title }) }))
  time.advance(1_000)
  crash({
    id: new Date(time.now()).toISOString().replace(/[:.]/g, "-") + "-x",
    kind: "renderer-error",
    at: new Date(time.now()).toISOString(),
    message: `ENOENT: open '${CANARY.cwd}/billing.ts' for ${CANARY.email} with ${CANARY.token} via https://api.example.com/v1/files?token=abc`,
    stack: `SyntaxError: Unexpected token 'C', "${CANARY.prompt}" is not valid JSON\n    at read (${CANARY.cwd}/billing.ts:12:3)\n    at main (/Applications/Mako.app/Contents/Resources/app.asar/dist/main.js:4:1)`,
    source: CANARY.cwd,
    app: { version: "0.4.0", electron: "43", chrome: "140", node: "24" },
    os: { platform: "darwin", arch: "arm64", release: "26.1" },
    breadcrumbs: [`2026-10-07T12:00:00.000Z ipc mako:live-prompt`],
  })
  await hostTelemetry.sweep()
  await telemetry.flush()
  const sent = cloud.sent.map((request) => request.text).join("\n")
  for (const value of [CANARY.prompt, CANARY.title, "ada-canary", "secret-repo", CANARY.email, "CANARYCANARY", "contract.pdf", "token=abc", "/v1/files", "billing"])
    assert.ok(!sent.includes(value), `${value} leaked`)
  assert.deepEqual(cloud.names(), ["app.started", "thread.created", "turn.started", "turn.completed", "turn.started", "error.reported", "app.heartbeat"])
  const error = cloud.sent.flatMap((request) => request.batch.events).find((event) => event.name === "error.reported")
  assert.deepEqual(error?.props, {
    kind: "renderer-error",
    name: "SyntaxError",
    message: "ENOENT: open '<path>' for <email> with Bearer <secret> via https://api.example.com/<path>",
    stack: `SyntaxError: Unexpected token 'C', "<text>" is not valid JSON\n    at read (<path>:12:3)\n    at main (/Applications/Mako.app/Contents/Resources/app.asar/dist/main.js:4:1)`,
    breadcrumbs: ["ipc mako:live-prompt"],
  })
  await hostTelemetry.close()
})

test("crash reports from before the install, or from while error reports were off, are never sent", async () => {
  const { telemetry, cloud, time } = await open()
  const { host: hostTelemetry, crash } = host(telemetry, time, { attended: () => false })
  const report = (at: number): CrashReport => ({
    id: `${new Date(at).toISOString().replace(/[:.]/g, "-")}-${at}`, kind: "main-uncaught", at: new Date(at).toISOString(), message: "boom",
    app: { version: "0.4.0", electron: "43", chrome: "140", node: "24" }, os: { platform: "darwin", arch: "arm64", release: "26.1" }, breadcrumbs: [],
  })
  crash(report(time.now() - 60_000))
  await hostTelemetry.started(undefined)
  await hostTelemetry.sweep()
  await telemetry.choose({ errors: false })
  time.advance(1_000)
  crash(report(time.now()))
  await hostTelemetry.sweep()
  await telemetry.choose({ errors: true })
  await hostTelemetry.sweep()
  time.advance(1_000)
  crash(report(time.now()))
  await hostTelemetry.sweep()
  await hostTelemetry.sweep()
  await telemetry.flush()
  assert.deepEqual(cloud.names(), ["app.started", "error.reported"])
  await hostTelemetry.close()
})

test("the heartbeat goes once a day, and only while someone has a window open", async () => {
  let attended = false
  const { telemetry, cloud, time } = await open()
  const { host: hostTelemetry } = host(telemetry, time, { attended: () => attended })
  await hostTelemetry.sweep()
  attended = true
  await hostTelemetry.sweep()
  time.advance(60 * 60_000)
  await hostTelemetry.sweep()
  time.advance(24 * 60 * 60_000)
  await hostTelemetry.sweep()
  await telemetry.flush()
  assert.deepEqual(cloud.names(), ["app.heartbeat", "app.heartbeat"])
  assert.deepEqual(cloud.sent[0]?.batch.events[0]?.props, { harnesses: [{ harness: "claude", version: "2.0.14" }, { harness: "codex" }], threads: 12, signedIn: false })
  await hostTelemetry.close()
})

test("unknown native records are counted since the last report, and MCP tools aren't named", () => {
  const reported = new Map<string, number>()
  const kinds = [
    { harness: "codex", kind: "item/reasoning-v2", reason: "unknown" as const, count: 3, firstSeen: 1 },
    { harness: "claude", kind: "tool mcp__acme-internal__deploy", reason: "unknown" as const, count: 1, firstSeen: 1 },
  ]
  assert.deepEqual(unknownSince(kinds, reported), [
    { harness: "codex", kind: "item/reasoning-v2", reason: "unknown", count: 3 },
    { harness: "claude", kind: "tool <mcp>", reason: "unknown", count: 1 },
  ])
  assert.deepEqual(unknownSince(kinds, reported), [])
  assert.deepEqual(unknownSince([{ ...kinds[0]!, count: 5 }], reported), [{ harness: "codex", kind: "item/reasoning-v2", reason: "unknown", count: 2 }])
})

test("the scrubber keeps an error's shape and loses what identifies anyone", () => {
  assert.equal(scrub("Error at C:\\Users\\ada\\repo\\x.ts:1:2"), "Error at <path>:1:2")
  assert.equal(scrub("open ~/Projects/secret/x.ts"), "open <path>")
  assert.equal(scrub("key=abcd1234 and sk-ant-api03-abcdefghij"), "<secret> and <secret>")
  assert.equal(scrub("fetch https://host.example.com"), "fetch https://host.example.com", "a bare host stays")
  assert.equal(scrub(`'short'`), `'short'`)
  assert.equal(harnessInventory(["claude", "Bad Name"], {}).length, 1)
  assert.equal(errorReported({ id: "x", kind: "main-rejection", at: "", message: "m", app: { version: "", electron: "", chrome: "", node: "" }, os: { platform: "", arch: "", release: "" }, breadcrumbs: [] }).kind, "main-rejection")
})
