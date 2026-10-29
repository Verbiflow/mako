import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { connect, createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { duplexPair } from "node:stream"
import { parseArgs } from "node:util"
import { z } from "zod"
import { NothingArrivedError, PROBE_ANSWER_MS, SILENT_WHILE_WORKING_MS, StreamCursor, clientSessionOverSockets, followAgainInMs, sessionStream, threadStream, type Actor, type Subscription } from "@mako/protocol"
import { accountStream } from "@mako/protocol/account-events"
import { holdHostLease } from "@mako/host/base/host-idle"
import { gatewayHostCalls } from "@mako/host/contracts/gateway-host-calls"
import type { RuntimePacket } from "@mako/host/contracts/runtime"
import { splitRuntimeEventLine } from "@mako/host/contracts/runtime-value"
import { invokeRuntime, runtimeInfo, subscribeRuntime } from "@mako/host/transport/connection"
import { hostCommand, runtimeLocation } from "@mako/host/transport/service"
import { MachineRuntime } from "@mako/host/usage/machine-runtime"
import { Gateway } from "../src/web-client/gateway.ts"
import { assertOwnHarnessStores } from "./lib/proof-host.ts"
import { removeScratch } from "./lib/scratch-processes.mjs"
import { fakeCloud, helperCloud, type BenchCloud } from "./lib/sync-bench-cloud.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"

/**
 * How long one device takes to see what another does, on the real code: `npm run bench:sync-latency`.
 *
 * Two screenless hosts of this checkout sign in to one account: Mac A runs a sealed Codex against the stand-in model,
 * paced to a word every 20 ms (about 50 tokens a second), each word unique (`t<turn>w<n>`) so its first arrival
 * anywhere is found by its text; Mac B opens A's conversation as a window does. A phone is played at the protocol level
 * through the web client's own `Gateway`, following A's conversation and the account's list as the web client does. A
 * cloud Thread's machine runtime (the real `MachineRuntime`, in this process) is fed A's live batches as they happen,
 * and three clients watch its Thread from its head. Each device reaches the cloud through a link of its own that the
 * bench can stall (nothing moves, nothing closes) or cut. One clock, this process's, times every hop.
 *
 * Without `--cloud` the cloud is the protocol's fake gateway, in this process (`lib/sync-bench-cloud.ts`): the hosts'
 * own hops, needing nothing private. With `--cloud <url>` it is that gateway, and a helper on this process's stdin
 * and stdout plays the person there (`helperCloud`); the gateway's own repository has one for a local gateway.
 *
 * It prints one JSON report to stdout (progress goes to stderr) and checks it against the budgets below: past any of
 * them it exits 1, unless `--report-only`. A run that fails to finish exits 2 either way.
 *
 *   npm run bench:sync-latency [-- --report-only] [--out <file>] [--quiet] [--trace <file>]
 *   npm run bench:sync-latency -- --cloud <url> [--presence]   with a helper on stdin and stdout
 */
const { values } = parseArgs({
  options: {
    cloud: { type: "string" },
    out: { type: "string" },
    trace: { type: "string" },
    "report-only": { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    "quiet-wait": { type: "string", default: "150" },
    presence: { type: "boolean", default: false },
    pace: { type: "string", default: "20" },
    words: { type: "string", default: "150" },
    turns: { type: "string", default: "5" },
    keep: { type: "boolean", default: false },
  },
})
const PACE = Number(values.pace)
const WORDS = Number(values.words)
const TURNS = Number(values.turns)
const QUIET_WAIT_MS = Number(values["quiet-wait"]) * 1000

/**
 * The plan's targets, as this bench measures them. Live content: each hop past the owner's own emission, p95, to the
 * device's host or page. Status: p95 from the change on the owner to each device. Reconnect: every word, current
 * within a second of the link returning, without a whole snapshot, and a stalled link noticed within five seconds.
 * Quiet: a clean drop said within 35 s, a silent one within 90 s, a quit at once. Cost: at most a message every two
 * tokens and 150 bytes a token on each hop. A gateway on another computer adds its network to live and status.
 */
const BUDGETS = {
  local: { liveHopMs: 10, statusMs: 300 },
  remote: { liveHopMs: 50, statusMs: 500 },
  reconnect: { currentMs: 1_000, wordsMissed: 0, rereads: 0, stallNoticedMs: 5_000 },
  quiet: { killMs: 35_000, freezeMs: 90_000, quitMs: 2_000 },
  cost: { messagesPerToken: 0.5, bytesPerToken: 150 },
} as const
/** A device is current once it shows every word the owner emitted more than this long ago. */
const CURRENT_LAG_MS = 50
/** How much earlier than the owner's own packet another device's may come (both leave the owner's host at once). */
const EARLY_MS = 20

const progress = (line: string) => process.stderr.write(`${line}\n`)
const now = () => performance.now()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, check: () => boolean, ms = 30_000): Promise<number> {
  for (const deadline = now() + ms; now() < deadline; await sleep(5)) if (check()) return now()
  throw new Error(`timed out: ${what}`)
}

/* ---------------------------------------------------------- what was seen, and when */

/** One thing a device did, for `--trace`: `detail` is a route, a state or an error; `deviceId` and `since` a quiet device. */
type Note = { t: number; src: string; kind: string; detail?: string; deviceId?: string; since?: string | null; n?: number }
const notes: Note[] = []
const note = (src: string, kind: string, data: Omit<Note, "t" | "src" | "kind"> = {}) => void notes.push({ t: Math.round(now() * 100) / 100, src, kind, ...data })

/** Which part of the run it is: live content and cost are read from the steady turns only. */
type Phase = "setup" | "first" | "steady" | "approval" | "concurrent" | "title" | "disturb" | "archive" | "quiet"
let phase: Phase = "setup"

const TOKEN = /\b(t\d+w\d+)\b/g
const sentAt = new Map<string, number>()
/** By device: when each word first reached it live. */
const seen = new Map<string, Map<string, number>>()
/** By device: when each word it missed live was read again by a snapshot. */
const reread = new Map<string, Map<string, number>>()
const rereads: Array<{ device: string; t: number; why: string }> = []
function scan(into: Map<string, Map<string, number>>, device: string, text: string, at = now()): number {
  let map = into.get(device)
  if (!map) into.set(device, (map = new Map()))
  let fresh = 0
  for (const match of text.matchAll(TOKEN))
    if (!map.has(match[1]!)) {
      map.set(match[1]!, at)
      fresh++
    }
  return fresh
}
const turnWords = (turn: number | string, count = WORDS) => Array.from({ length: count }, (_, index) => `t${turn}w${index + 1}`)
const saw = (device: string, word: string) => seen.get(device)?.has(word) ?? false

/** Messages and bytes each hop carried during the steady turns. */
const carried = new Map<string, { messages: number; bytes: number }>()
function carry(hop: string, bytes: number) {
  if (phase !== "steady") return
  const held = carried.get(hop) ?? { messages: 0, bytes: 0 }
  held.messages++
  held.bytes += bytes
  carried.set(hop, held)
}

const PermissionSchema = z.object({ id: z.string(), options: z.array(z.object({ optionId: z.string(), kind: z.string().optional() }).loose()) }).loose()
type Permission = z.infer<typeof PermissionSchema>
/** What this bench reads of a live batch: its numbering, whether its history changed, its status and what it asks. */
const BatchSchema = z.object({
  epoch: z.union([z.string(), z.number()]).optional(),
  revision: z.number().optional(),
  historyChanged: z.boolean().optional(),
  sessionChanges: z.object({ status: z.string().optional() }).loose().optional(),
  permissions: z.array(PermissionSchema).optional(),
}).loose()
type Batch = z.infer<typeof BatchSchema>
const batchOf = (payload: string): Batch => z.object({ batch: BatchSchema }).safeParse(JSON.parse(payload)).data?.batch ?? {}

/**
 * A window's reading of a conversation's batches: a revision past the next one, or a notice that its history changed,
 * is read again as a snapshot (`applyLiveBatch` and `hydrateLive` in `src/state/live-recovery.ts`).
 */
function windowOf(device: string, snapshot: () => Promise<string>) {
  let last: { epoch: Batch["epoch"]; revision: number } | undefined
  let reading = false
  return (batch: Batch) => {
    const { revision } = batch
    if (revision === undefined) return
    const before = last
    const same = before !== undefined && before.epoch === batch.epoch ? before : undefined
    const gap = batch.historyChanged === true || (same !== undefined && revision > same.revision + 1)
    last = { epoch: batch.epoch, revision: Math.max(revision, same?.revision ?? 0) }
    if (!gap || reading) return
    reading = true
    rereads.push({ device, t: now(), why: batch.historyChanged === true ? "history changed" : "revision gap" })
    void snapshot()
      .then((text) => void scan(reread, device, text))
      .catch((error: Error) => note(device, "reread-failed", { detail: error.message }))
      .finally(() => (reading = false))
  }
}

/* ---------------------------------------------------------- links */

/** A device's link to the cloud: a TCP proxy that can stall it (nothing moves, nothing closes) or cut it (reset). */
/** One connection through a link: the device's end, the cloud's, and the WebSocket route it opened, if it opened one. */
type Pair = { a: Socket; b: Socket; path?: string; unpiped?: boolean }
function link(name: string, upstream: URL) {
  const pairs = new Set<Pair>()
  let frozen = false
  /** Each WebSocket the device opened through it, by its route, and when. */
  const upgrades: Array<{ t: number; path: string }> = []
  /** When each connection the device opened was accepted: while stalled, a new one is the device replacing a silent socket. */
  const accepts: number[] = []
  const server: Server = createServer((a) => {
    accepts.push(now())
    const b = connect(Number(upstream.port || 80), upstream.hostname)
    const pair: Pair = { a, b }
    pairs.add(pair)
    a.once("data", (chunk: Buffer) => {
      const head = chunk.toString("latin1", 0, Math.min(chunk.length, 4096))
      const path = /^GET (\S+) HTTP/.exec(head)?.[1]
      if (!path || !/^upgrade: websocket/im.test(head)) return
      pair.path = path
      upgrades.push({ t: now(), path })
      note(`link-${name}`, "upgrade", { detail: path })
    })
    a.pipe(b)
    b.pipe(a)
    if (frozen) {
      a.pause()
      b.pause()
    }
    const end = () => {
      pairs.delete(pair)
      a.destroy()
      b.destroy()
    }
    a.on("error", end).on("close", end)
    b.on("error", end).on("close", end)
  })
  return {
    name,
    upgrades,
    accepts,
    /** The routes of the WebSockets open through it now. */
    open: () => new Set([...pairs].flatMap((pair) => (pair.path ? [pair.path] : []))),
    listen: () => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`))),
    freeze() {
      frozen = true
      for (const pair of pairs) {
        pair.a.unpipe(pair.b)
        pair.b.unpipe(pair.a)
        pair.a.pause()
        pair.b.pause()
        pair.unpiped = true
      }
    },
    thaw() {
      frozen = false
      for (const pair of pairs) {
        // A connection opened during the stall was piped as it opened, and only held: piped twice, its bytes would go twice.
        if (pair.unpiped) {
          pair.a.pipe(pair.b)
          pair.b.pipe(pair.a)
          delete pair.unpiped
        }
        pair.a.resume()
        pair.b.resume()
      }
    },
    cut() {
      // The link comes back working: whatever opens next passes.
      frozen = false
      for (const { a, b } of pairs) {
        a.resetAndDestroy()
        b.resetAndDestroy()
      }
      pairs.clear()
    },
    close() {
      for (const { a, b } of pairs) {
        a.destroy()
        b.destroy()
      }
      server.close()
    },
  }
}
type Link = ReturnType<typeof link>

/* ---------------------------------------------------------- the run */

const cloud: BenchCloud = values.cloud ? helperCloud(values.cloud, values.presence) : await fakeCloud()
/** Links go through proxies only to a gateway reached over plain HTTP: a TLS gateway's would need the proxy to speak for it. */
const proxied = new URL(cloud.url).protocol === "http:"
const budgets = cloud.local ? BUDGETS.local : BUDGETS.remote
const root = mkdtempSync(join(tmpdir(), "mako-sync-bench-"))
const head = { version: 1, at: new Date().toISOString(), gateway: cloud.name, local: cloud.local, pace: PACE, words: WORDS, turns: TURNS }
/** The report as printed: the run's settings, then what it measured against the budgets, or why it stopped. */
let report = JSON.stringify(head, null, 2)
const skipped: Record<string, string> = {}
const started = now()

const DeltaSchema = z.object({ type: z.literal("response.output_text.delta"), delta: z.string() })
const model = await scriptedModel({
  pace: PACE,
  sent: (event) => {
    const delta = DeltaSchema.safeParse(event).data?.delta
    if (delta !== undefined)
      for (const match of delta.matchAll(TOKEN)) if (!sentAt.has(match[1]!)) sentAt.set(match[1]!, now())
    if (event.type === "response.completed") note("model", "completed")
  },
  /** Each request's latest `BENCH-<tag>` says what to stream: `T<n>` a paced answer, `ASK<n>` a command needing approval first. */
  reply: (heard): ScriptedReply | undefined => {
    const last = [...heard.matchAll(/BENCH-(T\d+|ASK\d+)/g)].at(-1)
    if (!last) return { text: "Done." }
    const tag = last[1]!
    if (tag.startsWith("T")) return { text: turnWords(tag.slice(1)).join(" ") }
    const id = `call_${tag.toLowerCase()}`
    if (heard.slice(last.index).includes(id)) return { text: turnWords(`${tag.slice(3)}9`, 20).join(" ") }
    return { text: "Running it.", call: { id, name: "exec_command", arguments: { cmd: "echo bench" } } }
  },
})

const electron = z.string().parse(createRequire(import.meta.url)("electron"))
const AccountSchema = z.object({
  state: z.object({ status: z.string(), url: z.string().optional(), device: z.object({ id: z.string() }).loose().optional(), account: z.object({ entitlements: z.array(z.string()) }).loose().optional() }).loose(),
}).loose()
type Host = { name: string; socket: string; client: string; deviceId: string; process: ChildProcess; alive: boolean; release: () => Promise<void>; call: (channel: string, args: unknown[]) => ReturnType<typeof invokeRuntime>; link: Link | undefined; api: string }

async function startHost(name: string): Promise<Host> {
  const home = join(root, name, "home")
  const dataRoot = join(home, "Library", "Application Support", "mako-sync-bench", "profile")
  await mkdir(join(home, ".mako"), { recursive: true })
  await writeFile(join(home, ".mako", "syncd-login-optout"), "")
  await mkdir(join(dataRoot, "cloud"), { recursive: true, mode: 0o700 })
  await writeFile(join(dataRoot, "cloud", "sign-ins.json"), JSON.stringify({ version: 2, sharing: false, accessOnly: true, inStep: {} }), { mode: 0o600 })
  await mkdir(join(home, ".codex"), { recursive: true })
  await writeFile(join(home, ".codex", "config.toml"), `openai_base_url = "${model.url}/v1"\nchatgpt_base_url = "${model.url}/backend-api"\n\n[features]\nplugins = false\n`)
  await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "mako-sync-bench" }), { mode: 0o600 })
  const api = join(home, "projects", "api")
  await mkdir(join(api, ".git"), { recursive: true })
  const own = proxied ? link(name, new URL(cloud.url)) : undefined
  const reach = own ? await own.listen() : cloud.url
  const { socket } = runtimeLocation(dataRoot)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: socket, MAKO_CLOUD_URL: reach, MAKO_SCREENLESS: "1" }
  for (const variable of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "OPENCODE_DB", "MAKO_THREAD_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) delete env[variable]
  const command = hostCommand({ executable: electron, args: [process.cwd()], env })
  const child = spawn(command.executable, command.args, { env: command.env, stdio: "ignore" })
  process.once("exit", () => child.kill("SIGKILL"))
  for (const deadline = Date.now() + 90_000; !(await runtimeInfo(socket).catch(() => null)); await sleep(250))
    if (Date.now() > deadline) throw new Error(`host ${name} didn't start; its log is ${join(dataRoot, "logs", "host.log")}`)
  const release = await holdHostLease(runtimeLocation(dataRoot).directory)
  const client = randomUUID()
  const call = (channel: string, args: unknown[]) => invokeRuntime(socket, client, channel, args)
  await assertOwnHarnessStores(call, dataRoot)
  let account = AccountSchema.parse(await call("mako:cloud-sign-in", []))
  if (account.state.status === "signing-in") await cloud.signIn(z.string().parse(account.state.url))
  for (const deadline = Date.now() + 5 * 60_000; !(account.state.status === "signed-in" && account.state.account?.entitlements.includes("cloud")); await sleep(300)) {
    if (Date.now() > deadline) throw new Error(`host ${name} isn't signed in with the cloud: ${account.state.status}`)
    account = AccountSchema.parse(await call("mako:cloud-account", []))
  }
  const host: Host = { name, socket, client, deviceId: z.string().parse(account.state.device?.id), process: child, alive: true, release, call, link: own, api }
  child.once("exit", () => (host.alive = false))
  return host
}

/** Statuses as a list says them, from what a batch says (`ListedState`). */
const listedOf = (status: string | undefined) => (status === "running" ? "working" : status === "ready" ? "idle" : status === "failed" ? "failed" : undefined)
type Change = { t: number; state: string; phase: Phase }
/** By device: each state it showed conversation C in, in order. */
const states = new Map<string, Change[]>()
function showed(device: string, state: string | undefined, at = now()) {
  if (!state) return
  const list = states.get(device) ?? []
  if (list.at(-1)?.state === state) return
  list.push({ t: at, state, phase })
  note(device, "state", { detail: state })
  states.set(device, list)
}
/** The other things a list says, by device: C listed for the first time, a title, C leaving the list. */
const listed = new Map<string, number>()
const titled = new Map<string, Map<string, number>>()
const unlisted = new Map<string, number>()
let pendingTitle: string | undefined

/** Every packet a host's windows get, kept as what matters here: conversation C's batches and the list's changes. */
function watchHost(host: Host, conversation: () => string | undefined, window?: (batch: Batch) => void) {
  return subscribeRuntime(host.socket, host.client, (packet: RuntimePacket) => {
    const at = now()
    if (!("payload" in packet)) return
    const C = conversation()
    if (!C) return
    const mentions = packet.payload.includes(C)
    // Each title is new to this run, so the first packet that carries it is the device hearing of it, whatever it names.
    if (pendingTitle && packet.payload.includes(pendingTitle) && !titled.get(host.name)?.has(pendingTitle)) titled.set(host.name, (titled.get(host.name) ?? new Map()).set(pendingTitle, at))
    if (packet.type === "live-batch") {
      if (packet.conversation !== C) return
      scan(seen, host.name, packet.payload, at)
      carry(host.name, packet.payload.length)
      const batch = batchOf(packet.payload)
      const permission = batch.permissions?.[0]
      showed(host.name, permission ? "waiting" : listedOf(batch.sessionChanges?.status), at)
      showedLive(host.name, listedOf(batch.sessionChanges?.status), at)
      window?.(batch)
      if (permission && host.name === "A") asked ??= permission
      return
    }
    if (!mentions) return
    if (packet.type === "live-listed" && !listed.has(host.name)) listed.set(host.name, at)
    if (packet.type === "live-unlisted" && !unlisted.has(host.name)) unlisted.set(host.name, at)
  }, () => note(host.name, "events-ended"))
}

const hosts: Host[] = []
const stops: Array<() => void> = []
let machine: MachineRuntime | undefined
let C: string | undefined
let following = true
let exitCode = 0
/** The first approval A asked for. */
let asked: Permission | undefined
const disturbances: Array<{ name: string; link: Link; turn: number; at: number; back: number; watchers: string[]; stall: boolean; open: Set<string>; ended?: boolean }> = []
/** By watching device: the state each live batch of C left it in, in order, for a turn's end that went missing. */
const liveStates = new Map<string, Array<{ t: number; state: string }>>()
function showedLive(device: string, state: string | undefined, at = now()) {
  if (!state) return
  const list = liveStates.get(device) ?? []
  if (list.at(-1)?.state !== state) list.push({ t: at, state })
  liveStates.set(device, list)
}
const quiet: Record<string, { ms: number | null; waitedMs: number }> = {}

try {
  await cloud.account()
  const A = await startHost("A")
  hosts.push(A)
  const B = await startHost("B")
  hosts.push(B)
  progress(`signed in: A ${A.deviceId}, B ${B.deviceId}`)

  /* -- the phone, through the web client's own gateway */
  const phoneLink = proxied ? link("phone", new URL(cloud.url)) : undefined
  const phone = new Gateway({ origin: phoneLink ? await phoneLink.listen() : cloud.url, connect: () => cloud.phone() })
  const { account, deviceId: phoneDevice } = await phone.connection()
  const actor: Actor = { kind: "client", client: "web", deviceId: phoneDevice }
  let session: string | undefined
  /** The phone follows the account's list before A starts anything, so a new Thread is timed from its first word there. */
  let listening!: () => void
  const phoneListening = new Promise<void>((resolve) => (listening = resolve))
  // The phone's list: read once, then followed after its number; a stream that ends is listed again (as `account-list.ts`).
  const Listing = z.object({ seq: z.number(), sessions: z.array(z.object({ conversation: z.string(), session: z.string(), state: z.string(), runsOn: z.object({ deviceId: z.string().optional() }).loose() }).loose()) }).loose()
  void (async () => {
    for (let round = 0; following; round++) {
      if (round) await sleep(500)
      const listing = Listing.safeParse(await phone.rest("GET", "/v1/sessions").catch(() => undefined)).data
      if (!listing) continue
      const row = C ? listing.sessions.find((item) => item.conversation === C) : undefined
      if (row) showed("phone", row.state)
      // A list read again after a dropped stream may be the first to name it.
      if (row && !listed.has("phone")) listed.set("phone", now())
      try {
        const stream = phone.session.subscribe({ stream: accountStream(account.id), after: listing.seq })
        listening()
        for (;;) {
          const frame = await stream.next()
          const at = now()
          const event = z.object({ type: z.string(), sessions: z.array(z.unknown()).optional(), deviceId: z.string().optional(), since: z.string().nullable().optional() }).loose().parse(JSON.parse(frame.event.text))
          if (event.type === "device-quiet") note("phone", "device-quiet", { deviceId: event.deviceId, since: event.since })
          if (event.type === "sessions-unlisted" && session && event.sessions?.includes(session) && !unlisted.has("phone")) unlisted.set("phone", at)
          if (event.type !== "sessions-listed" || !C) continue
          const mine = z.array(z.object({ conversation: z.string(), session: z.string(), state: z.string(), threadTitle: z.string().optional() }).loose()).parse(event.sessions).find((item) => item.conversation === C)
          if (!mine) continue
          session = mine.session
          if (!listed.has("phone")) listed.set("phone", at)
          showed("phone", mine.state, at)
          if (pendingTitle && mine.threadTitle === pendingTitle && !titled.get("phone")?.has(pendingTitle)) titled.set("phone", (titled.get("phone") ?? new Map()).set(pendingTitle, at))
        }
      } catch (error) {
        note("phone", "account-ended", { detail: error instanceof Error ? error.message : String(error) })
      }
    }
  })()

  /* -- 1. a new Thread and its first turn, started on A */
  C = randomUUID()
  const conversation = C
  const ownerRuntime = `d-${A.deviceId}`
  const phoneCalls = gatewayHostCalls(phone.session, { runtimeId: ownerRuntime, actor, history: true })
  /** A call from the phone, asked again under the same ID while its connection closes under it (`sendWithRepeats`). */
  const fromPhone = async (channel: string, args: unknown[]) => {
    const call = phoneCalls.call(channel, args)
    for (let attempt = 1; ; attempt++) {
      try {
        return await call(attempt)
      } catch (error) {
        if (attempt >= 8) throw error
        await sleep(250)
      }
    }
  }
  const snapshotOn = (host: Host) => async () => JSON.stringify(await host.call("mako:live-snapshot", [conversation]))
  stops.push(watchHost(A, () => C), watchHost(B, () => C, windowOf("B", snapshotOn(B))))
  await phoneListening
  phase = "first"
  const startedAt = now()
  await A.call("mako:live-start", ["codex", A.api, { conversationId: C, modeId: "access:ask", title: "Sync bench", initialRequest: { id: randomUUID(), text: "BENCH-T1 stream please", attachments: [] } }])
  await until("turn 1 on A", () => saw("A", `t1w${WORDS}`), 120_000)
  await until("the phone's row idle", () => states.get("phone")?.at(-1)?.state === "idle", 30_000).catch(() => note("bench", "phone-row-not-idle"))
  await sleep(2_000)

  /* -- 2. the phone and B open it, as their windows do */
  const phoneWindow = windowOf("phone", async () => String(await fromPhone("mako:live-snapshot", [conversation])))
  let phoneLive: Subscription | undefined
  /** Whether C is at work, as the phone last heard: while it is, a silent stream has its connection probed. */
  let phoneWorking = false
  // As `src/web-client/conversations.ts` follows a device's conversation: from what the gateway kept after the last
  // update heard, a skipped number asked for again at once, a snapshot only where the stream can't be picked up.
  const phoneStream = sessionStream(ownerRuntime, conversation)
  void (async () => {
    let failures = 0
    let gapsInRow = 0
    const cursor = new StreamCursor("live")
    for (let first = true; following; first = false) {
      try {
        const resumes = cursor.numbered
        phoneLive = phone.session.subscribe({ stream: phoneStream, after: cursor.resumeAfter() })
        if (!first && !resumes) {
          rereads.push({ device: "phone", t: now(), why: "followed again" })
          void fromPhone("mako:live-snapshot", [conversation]).then((text) => void scan(reread, "phone", String(text))).catch(() => undefined)
        }
        let gap = false
        while (!gap) {
          let frame
          try {
            frame = await phoneLive.next(phoneWorking ? SILENT_WHILE_WORKING_MS : undefined)
          } catch (error) {
            if (!(error instanceof NothingArrivedError)) throw error
            note("phone", "probe")
            phone.session.probe(phoneStream, PROBE_ANSWER_MS)
            continue
          }
          const verdict = cursor.heard({ seq: frame.seq, text: frame.event.text })
          if (verdict.kind === "notice" || verdict.kind === "duplicate") continue
          if (verdict.kind === "reread") {
            rereads.push({ device: "phone", t: now(), why: "past what the gateway kept" })
            void fromPhone("mako:live-snapshot", [conversation]).then((text) => void scan(reread, "phone", String(text))).catch(() => undefined)
            continue
          }
          if (verdict.kind === "gap") {
            note("phone", "gap")
            gap = true
            continue
          }
          const at = now()
          failures = 0
          gapsInRow = 0
          scan(seen, "phone", frame.event.text, at)
          carry("phone", frame.event.text.length)
          const parts = splitRuntimeEventLine(frame.event.text)
          if (!parts) continue
          const batch = batchOf(parts.payload)
          const status = batch.sessionChanges?.status
          if (status !== undefined) phoneWorking = status === "running"
          showedLive("phone", listedOf(status), at)
          phoneWindow(batch)
        }
        if (++gapsInRow <= 3) continue
      } catch (error) {
        note("phone", "live-ended", { detail: error instanceof Error ? error.message : String(error) })
      }
      await sleep(followAgainInMs(failures++))
    }
  })()
  scan(reread, "phone", String(await fromPhone("mako:live-snapshot", [C])))
  scan(reread, "B", JSON.stringify(await B.call("mako:live-snapshot", [C])))
  await sleep(1_500)

  /* -- 3. a cloud Thread's machine runtime, fed A's batches */
  const place = await cloud.cloudThread()
  if (!place) skipped.cloud = "the gateway's helper made no cloud Thread"
  else {
    const [agentEnd, hostEnd] = duplexPair()
    agentEnd.resume()
    machine = new MachineRuntime({
      agent: hostEnd,
      invoke: async () => '{"ok":true}',
      version: "bench",
      build: "bench",
      dataRoot: join(root, "machine"),
      installSignIns: async () => [],
      openWorkspace: async () => {},
      prepareFolder: async () => {},
      prefetchStart: async () => undefined,
      prefetchSignedIn: async () => undefined,
      work: () => [],
      media: () => undefined,
      linked: async () => {},
      profileHost: false,
    })
    machine.start()
    agentEnd.write(`${JSON.stringify({ type: "link", gatewayUrl: place.gatewayUrl, runtimeId: place.runtimeId, credential: place.credential, machine: place.machine, generation: place.generation })}\n`)
    for (const name of ["cloud-1", "cloud-2", "cloud-3"]) {
      const watcher = clientSessionOverSockets(() => new WebSocket(place.watch))
      const stream = watcher.subscribe({ stream: threadStream(place.threadId), after: Number.MAX_SAFE_INTEGER })
      void (async () => {
        for (;;) {
          const frame = await stream.next()
          const at = now()
          scan(seen, name, frame.event.text, at)
          carry("cloud", frame.event.text.length)
        }
      })().catch(() => undefined)
      stops.push(() => watcher.close())
    }
    let tee = false
    stops.push(subscribeRuntime(A.socket, A.client, (packet) => {
      if (!tee || !("payload" in packet) || packet.type !== "live-batch" || packet.conversation !== C) return
      machine?.event(packet.channel, { type: packet.type, conversation: packet.conversation, payload: packet.payload })
    }, () => undefined))
    await sleep(3_000)
    tee = true
  }

  /* -- 4. steady turns started on A, watched everywhere */
  const turn = async (n: number, from: "A" | "phone" | "B" = "A", text = `BENCH-T${n} stream please`) => {
    note("bench", "turn", { n, detail: from })
    if (from === "A") await A.call("mako:live-prompt", [C, randomUUID(), text, []])
    else if (from === "B") await B.call("mako:live-prompt", [C, randomUUID(), text, []])
    else await fromPhone("mako:live-prompt", [C, randomUUID(), text, []])
  }
  phase = "steady"
  progress("steady turns")
  for (let n = 2; n < 2 + TURNS; n++) {
    await turn(n)
    await until(`turn ${n} on A`, () => saw("A", `t${n}w${WORDS}`), 120_000)
    await sleep(2_500)
  }

  /* -- 5. an approval: asked on A, answered from the phone */
  phase = "approval"
  await turn(30, "A", "BENCH-ASK30 run it")
  await until("an approval on A", () => asked !== undefined, 60_000)
  const permission = PermissionSchema.parse(asked)
  await sleep(1_500)
  const allow = permission.options.find((option) => option.kind === "allow_once") ?? permission.options[0]!
  await fromPhone("mako:live-permission", [C, permission.id, { kind: "choice", optionId: allow.optionId }])
  await until("the approved turn's answer on A", () => saw("A", "t309w20"), 60_000)
  await sleep(2_500)

  /* -- 6. two devices send at once: the phone and B */
  phase = "concurrent"
  await Promise.all([turn(40, "phone", "BENCH-T40 from the phone"), turn(41, "B", "BENCH-T41 from B")])
  await until("both sends answered on A", () => saw("A", `t40w${WORDS}`) && saw("A", `t41w${WORDS}`), 120_000)
  await sleep(2_500)

  /* -- 7. the Thread renamed on A, three times */
  phase = "title"
  const thread = z.object({ thread: z.string() }).loose().parse((await phone.rest("GET", "/v1/sessions").then((answer) => Listing.parse(answer).sessions.find((item) => item.conversation === C)))).thread
  const titles: Array<{ title: string; at: number }> = []
  for (let n = 1; n <= 3; n++) {
    const title = `Sync bench ${n} ${randomUUID().slice(0, 6)}`
    pendingTitle = title
    await A.call("mako:thread-rename", [randomUUID(), thread, title])
    titles.push({ title, at: now() })
    await sleep(2_000)
  }
  pendingTitle = undefined

  /* -- 8. links that stall or drop mid-turn */
  phase = "disturb"
  if (!proxied || !A.link || !B.link || !phoneLink) skipped.reconnect = "a gateway over TLS is reached directly, with no link the bench can stall or cut"
  else {
    progress("disturbances")
    const disturb = async (name: string, n: number, target: Link, watchers: string[], how: { stallMs?: number; settleMs: number }) => {
      await turn(n)
      await until(`turn ${n} started on A`, () => saw("A", `t${n}w30`), 60_000)
      const at = now()
      const open = target.open()
      if (how.stallMs) {
        target.freeze()
        await sleep(how.stallMs)
        target.thaw()
      } else target.cut()
      disturbances.push({ name, link: target, turn: n, at, back: now(), watchers, stall: how.stallMs !== undefined, open })
      await until(`turn ${n} on A`, () => saw("A", `t${n}w${WORDS}`), 60_000)
      await sleep(how.settleMs)
    }
    await disturb("phone link cut", 50, phoneLink, ["phone"], { settleMs: 5_000 })
    await disturb("B's link stalled 8 s", 51, B.link, ["B"], { stallMs: 8_000, settleMs: 5_000 })
    await disturb("B's link cut", 52, B.link, ["B"], { settleMs: 8_000 })
    await disturb("A's link stalled 5 s", 53, A.link, ["phone", "B"], { stallMs: 5_000, settleMs: 5_000 })
    await disturb("A's link cut", 54, A.link, ["phone", "B"], { settleMs: 8_000 })
    // The owner's last batch lost: its link stalls as the turn ends, so the end goes into a socket that then drops.
    // Nothing comes after it to show a gap: only the owner sending again what its new link's gateway didn't relay.
    await turn(55)
    await until("turn 55 nearly done on A", () => saw("A", `t55w${WORDS - 10}`), 60_000)
    const open = A.link.open()
    const at = now()
    A.link.freeze()
    await until("turn 55 ended on A", () => saw("A", `t55w${WORDS}`) && liveStates.get("A")?.at(-1)?.state === "idle", 60_000)
    await sleep(300)
    A.link.cut()
    disturbances.push({ name: "A's last batch lost", link: A.link, turn: 55, at, back: now(), watchers: ["phone", "B"], stall: false, open, ended: true })
    await sleep(8_000)
  }

  /* -- 9. archived on A */
  phase = "archive"
  await A.call("mako:thread-archive", [{ id: randomUUID(), target: { kind: "live", id: C }, archived: true }])
  const archivedAt = now()
  await until("the archive on the phone", () => unlisted.has("phone"), 10_000).catch(() => note("bench", "archive-not-heard"))
  await sleep(1_000)

  /* -- 10. devices going away: how long until the phone says each is quiet */
  phase = "quiet"
  const quietOf = (deviceId: string, after: number) => notes.find((item) => item.kind === "device-quiet" && item.deviceId === deviceId && item.since !== null && item.t >= after)
  const awaitQuiet = async (name: string, host: Host, act: () => void) => {
    const at = now()
    act()
    const heard = await until(`${name}: the phone says ${host.name} is quiet`, () => quietOf(host.deviceId, at) !== undefined, QUIET_WAIT_MS).catch(() => undefined)
    quiet[name] = { ms: heard === undefined ? null : Math.round(heard - at), waitedMs: QUIET_WAIT_MS }
    progress(`quiet ${name}: ${quiet[name].ms ?? `not within ${QUIET_WAIT_MS} ms`}`)
  }
  if (!values.quiet) skipped.quiet = "not asked for (--quiet)"
  else if (!cloud.presence) skipped.quiet = "this gateway says no presence (the fake gateway keeps none)"
  else {
    progress("quiet devices")
    await awaitQuiet("freeze", B, () => B.process.kill("SIGSTOP"))
    B.process.kill("SIGCONT")
    await until("B back", () => notes.some((item) => item.kind === "device-quiet" && item.deviceId === B.deviceId && item.since === null), 60_000).catch(() => undefined)
    await awaitQuiet("quit", B, () => B.process.kill("SIGTERM"))
    await awaitQuiet("kill", A, () => A.process.kill("SIGKILL"))
  }
  following = false

  /* ---------------------------------------------------------- the report */

  const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!
  const round = (value: number) => Math.round(value * 10) / 10
  const stats = (xs: number[]) => {
    const sorted = [...xs].sort((a, b) => a - b)
    return sorted.length ? { n: sorted.length, p50: round(pct(sorted, 50)), p95: round(pct(sorted, 95)), max: round(sorted.at(-1)!) } : { n: 0, p50: null, p95: null, max: null }
  }
  const at = (device: string, word: string) => seen.get(device)?.get(word)
  const steady = Array.from({ length: TURNS }, (_, index) => turnWords(index + 2)).flat()
  const over = (device: string) => steady.flatMap((word) => {
    const there = at(device, word)
    const owner = at("A", word)
    return there === undefined || owner === undefined ? [] : [there - owner]
  })
  const live = {
    owner: stats(steady.flatMap((word) => (at("A", word) === undefined || !sentAt.has(word) ? [] : [at("A", word)! - sentAt.get(word)!]))),
    phone: stats(over("phone")),
    secondMac: stats(over("B")),
    cloud: place ? stats(["cloud-1", "cloud-2", "cloud-3"].flatMap(over)) : undefined,
  }

  // Status: each change on A, and when each device first showed it.
  // Turn 1 is before B and the phone open the conversation: its changes count only as `new`.
  const counted = (change: Change) => ["steady", "approval", "concurrent"].includes(change.phase)
  const ownerChanges = (states.get("A") ?? []).filter(counted)
  /**
   * Each time A entered `target` and held it 100 ms or more, how long until the device showed it, before A entered it
   * again; `missed` when it never did. A device already showing it has nothing to show. A device's packet may come a
   * moment before A's own, which travels A's event stream, so a little early counts as at once.
   */
  const statusOf = (target: string) => (device: string) => {
    const there = (states.get(device) ?? []).filter(counted)
    const entered = ownerChanges.filter((change, index) => change.state === target && (ownerChanges[index + 1]?.t ?? Infinity) - change.t >= 100)
    let missed = 0
    const delays = entered.flatMap((change, index) => {
      if (there.findLast((item) => item.t < change.t - EARLY_MS)?.state === target) return []
      const shown = there.find((item) => item.t >= change.t - EARLY_MS && item.t < (entered[index + 1]?.t ?? Infinity) && item.state === target)
      if (!shown) missed++
      return shown ? [Math.max(0, shown.t - change.t)] : []
    })
    return { ...stats(delays), missed }
  }
  /**
   * A turn's start, from the moment it was sent: the device's first `working` (or `waiting`) after the send and before
   * the next. A list says a conversation is at work before the owner's own batch does (the report goes as the prompt is
   * taken, the batch once the harness has it), so it's timed from the send rather than from A's batch.
   */
  // Two sends at once (the phone's and B's) are one start: the second waits behind the first, at work throughout.
  const sends = notes
    .filter((item) => item.src === "bench" && item.kind === "turn")
    .map((item) => ({ t: item.t, n: item.n ?? 0 }))
    .filter(({ n }) => n >= 2 && n < 50)
    .filter((send, index, all) => index === 0 || send.t - all[index - 1]!.t > 1_000)
  const startOn = (device: string) => {
    const there = states.get(device) ?? []
    let missed = 0
    const delays = sends.flatMap((send, index) => {
      const shown = there.find((item) => item.t >= send.t && item.t < (sends[index + 1]?.t ?? Infinity) && (item.state === "working" || item.state === "waiting"))
      if (!shown) missed++
      return shown ? [shown.t - send.t] : []
    })
    return { ...stats(delays), missed }
  }
  const newOn = (device: string) => stats(listed.has(device) ? [listed.get(device)! - startedAt] : [])
  const titleOn = (device: string) => {
    const delays = titles.flatMap(({ title, at: when }) => (titled.get(device)?.has(title) ? [titled.get(device)!.get(title)! - when] : []))
    return { ...stats(delays), missed: titles.length - delays.length }
  }
  const archiveOn = (device: string) => stats(unlisted.has(device) ? [unlisted.get(device)! - archivedAt] : [])
  const status = Object.fromEntries(
    ([["start", startOn], ["end", statusOf("idle")], ["waiting", statusOf("waiting")], ["new", newOn], ["title", titleOn], ["archive", archiveOn]] as const).map(([kind, of]) => [kind, { phone: of("phone"), secondMac: of("B") }])
  )

  // Reconnect: for each disturbance, what each watching device missed, how soon it was current, and how it got there.
  const shownAt = (device: string, word: string) => Math.min(seen.get(device)?.get(word) ?? Infinity, reread.get(device)?.get(word) ?? Infinity)
  const reconnect = Object.fromEntries(disturbances.map((disturbance) => {
    const words = turnWords(disturbance.turn).filter((word) => at("A", word) !== undefined)
    const end = Math.max(...words.map((word) => at("A", word)!)) + 3_000
    const devices = Object.fromEntries(disturbance.watchers.map((device) => {
      const name = device === "B" ? "secondMac" : device
      // Behind from the moment a word it hasn't shown is older than the lag, until it shows it: current once the last such word is shown.
      const missed = words.filter((word) => !Number.isFinite(shownAt(device, word)))
      const late = words.filter((word) => shownAt(device, word) - at("A", word)! > CURRENT_LAG_MS).map((word) => shownAt(device, word))
      const caughtUp = late.length ? Math.max(...late) : disturbance.back
      // Where the turn's end was in what went missing: when the device showed the conversation idle again.
      const idle = disturbance.ended ? liveStates.get(device)?.find((item) => item.t > disturbance.at && item.state === "idle") : undefined
      return [name, {
        ...(disturbance.ended && { turnEndShownMs: idle ? Math.max(0, Math.round(idle.t - disturbance.back)) : null }),
        wordsMissed: missed.length,
        wordsReread: words.filter((word) => !saw(device, word) && reread.get(device)?.has(word)).length,
        timeToCurrentMs: missed.length ? null : Math.max(0, Math.round(caughtUp - disturbance.back)),
        rereads: rereads.filter((item) => item.device === device && item.t >= disturbance.at && item.t <= end).length,
      }]
    }))
    // A stall is noticed when the device replaces a socket that went silent: it opens a connection again while stalled
    // (accepted, though nothing crosses it until the link moves again).
    const noticed = disturbance.link.accepts.find((t) => t > disturbance.at && t < disturbance.back)
    return [disturbance.name, { link: disturbance.link.name, ...(disturbance.stall && { stallNoticedMs: noticed === undefined ? null : Math.round(noticed - disturbance.at) }), devices }]
  }))

  const tokens = steady.length
  const cost = Object.fromEntries([["owner", "A"], ["phone", "phone"], ["secondMac", "B"], ["cloud", "cloud"]].flatMap(([hop, key]) => {
    const held = carried.get(key!)
    if (!held) return []
    const watchers = key === "cloud" ? 3 : 1
    return [[hop, { messages: held.messages, bytes: held.bytes, messagesPerToken: round((held.messages / watchers / tokens) * 100) / 100, bytesPerToken: round(held.bytes / watchers / tokens) }]]
  }))

  const measured = { ...head, live, status, reconnect, quiet: values.quiet && cloud.presence ? quiet : undefined, cost, skipped, seconds: Math.round((now() - started) / 1000) }

  const checks: Array<{ name: string; value: number | null; limit: number; ok: boolean }> = []
  const check = (name: string, value: number | null | undefined, limit: number) => checks.push({ name, value: value ?? null, limit, ok: value !== null && value !== undefined && value <= limit })
  for (const hop of ["phone", "secondMac", "cloud"] as const) if (live[hop]) check(`live.${hop}.p95`, live[hop].p95, budgets.liveHopMs)
  for (const [kind, devices] of Object.entries(status)) for (const [device, measured] of Object.entries(devices)) check(`status.${kind}.${device}.p95`, measured.p95, budgets.statusMs)
  for (const [name, measured] of Object.entries(reconnect)) {
    if ("stallNoticedMs" in measured) check(`reconnect.${name}.stallNoticedMs`, measured.stallNoticedMs, BUDGETS.reconnect.stallNoticedMs)
    for (const [device, seenThere] of Object.entries(measured.devices)) {
      check(`reconnect.${name}.${device}.timeToCurrentMs`, seenThere.timeToCurrentMs, BUDGETS.reconnect.currentMs)
      check(`reconnect.${name}.${device}.wordsMissed`, seenThere.wordsMissed, BUDGETS.reconnect.wordsMissed)
      check(`reconnect.${name}.${device}.rereads`, seenThere.rereads, BUDGETS.reconnect.rereads)
      if ("turnEndShownMs" in seenThere) check(`reconnect.${name}.${device}.turnEndShownMs`, seenThere.turnEndShownMs, BUDGETS.reconnect.currentMs)
    }
  }
  if (values.quiet && cloud.presence) {
    check("quiet.kill.ms", quiet.kill?.ms, BUDGETS.quiet.killMs)
    check("quiet.freeze.ms", quiet.freeze?.ms, BUDGETS.quiet.freezeMs)
    check("quiet.quit.ms", quiet.quit?.ms, BUDGETS.quiet.quitMs)
  }
  for (const [hop, measured] of Object.entries(cost)) {
    check(`cost.${hop}.messagesPerToken`, measured.messagesPerToken, BUDGETS.cost.messagesPerToken)
    check(`cost.${hop}.bytesPerToken`, measured.bytesPerToken, BUDGETS.cost.bytesPerToken)
  }
  const failed = checks.filter((item) => !item.ok)
  report = JSON.stringify({ ...measured, budgets: { local: cloud.local, checked: checks.length, failed: failed.length, over: failed }, ok: failed.length === 0 }, null, 2)
  progress(`${checks.length - failed.length} of ${checks.length} budgets met${failed.length ? `; over: ${failed.map((item) => item.name).join(", ")}` : ""}`)
  if (failed.length && !values["report-only"]) exitCode = 1
} catch (error) {
  const said = error instanceof Error ? (error.stack ?? error.message) : String(error)
  report = JSON.stringify({ ...head, error: said, skipped }, null, 2)
  progress(said)
  exitCode = 2
} finally {
  following = false
  for (const stop of stops) stop()
  machine?.stop()
  for (const host of hosts) {
    if (host.alive) await Promise.race([host.call("mako:cloud-sign-out", []).catch(() => undefined), sleep(5_000)])
    host.process.kill("SIGCONT")
    host.process.kill("SIGTERM")
    await host.release().catch(() => undefined)
    host.link?.close()
  }
  await model.close()
  await cloud.close()
  if (values.out) writeFileSync(values.out, `${report}\n`)
  if (values.trace) writeFileSync(values.trace, `${notes.map((item) => JSON.stringify(item)).join("\n")}\n`)
  process.stdout.write(`${report}\n`)
  if (values.keep) progress(`kept ${root}`)
  else await removeScratch(root).catch((error: Error) => progress(`couldn't remove ${root}: ${error.message}`))
  process.exit(exitCode)
}
