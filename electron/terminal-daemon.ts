import { createServer, createConnection, type Server, type Socket } from "node:net"
import { mkdir, chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { randomUUID } from "node:crypto"
import { spawn as spawnPty, type IDisposable, type IPty } from "@lydell/node-pty"
import { z } from "zod"
import {
  prepareMacosTerminalLogin,
  wrapMacosTerminalLogin,
} from "./macos-terminal-login.js"
import { childProcessEnv } from "./accounts-common.js"
import { TerminalHistoryFilter } from "./terminal-history-filter.js"
import { killTerminalProcessGroups } from "./terminal-process-groups.js"
import type { TerminalSession } from "./shared.js"
import {
  BoundedTerminalHistory,
  JsonLineDecoder,
  TERMINAL_DAEMON_VERSION,
  TERMINAL_FLOW_HIGH_BYTES,
  TERMINAL_FLOW_LOW_BYTES,
  TERMINAL_MAX_SESSIONS,
  TERMINAL_PROTOCOL_VERSION,
  encodeTerminalFrame,
  parseTerminalRequest,
  splitTerminalOutput,
  type TerminalDaemonEvent,
  type TerminalRequest,
  type TerminalResponse,
  type TerminalResult,
} from "./terminal-protocol.js"

interface LiveSession {
  summary: TerminalSession
  history: BoundedTerminalHistory
  historyFilter: TerminalHistoryFilter
  pty: IPty | null
  flowPaused: boolean
  pendingOutput: Array<{ sequence: number; data: string }>
  dataListener?: IDisposable
  exitListener?: IDisposable
}

interface SessionConsumer {
  pendingBytes: number
  pendingOutput: Map<number, number>
  snapshotSequence: number
}

interface ClientConnection {
  socket: Socket
  decoder: JsonLineDecoder
  blocked: boolean
  sessions: Map<string, SessionConsumer>
}

interface PersistedSession {
  summary: TerminalSession
  history: string
}

interface PersistedState {
  version: number
  savedAt: number
  sessions: PersistedSession[]
}

const persistedSessionSchema = z.object({
  history: z.string(),
  summary: z.object({
    id: z.string(),
    title: z.string(),
    cwd: z.string(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    status: z.enum(["running", "exited", "interrupted"]),
    cols: z.number().int(),
    rows: z.number().int(),
    sequence: z.number().int(),
    exitCode: z.number().int().optional(),
  }),
})
const persistedStateSchema = z.object({
  version: z.literal(TERMINAL_PROTOCOL_VERSION),
  savedAt: z.number().finite(),
  sessions: z.array(persistedSessionSchema).max(TERMINAL_MAX_SESSIONS),
})
const errnoSchema = z.object({ code: z.string() })

const endpoint = argument("--endpoint")
const stateDir = argument("--state-dir")
const build = optionalArgument("--build")
const historyFile = join(stateDir, "sessions.json")
const historyTemp = join(stateDir, "sessions.tmp")
const sessions = new Map<string, LiveSession>()
const clients = new Set<ClientConnection>()
const ENDPOINT_CHECK_MS = 5_000
let server: Server | null = null
let dirty = false
let saving: Promise<void> | null = null
let stopping = false

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function argument(name: string) {
  const value = optionalArgument(name)
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function sessionCopy(session: TerminalSession): TerminalSession {
  return { ...session }
}

function response(
  id: number,
  result: TerminalResult,
  protocol = TERMINAL_PROTOCOL_VERSION
): TerminalResponse {
  return {
    protocol,
    type: "response",
    id,
    ok: true,
    result,
  }
}

function failure(
  id: number,
  error: string,
  code: TerminalResponse["code"] = "invalid-request"
): TerminalResponse {
  return {
    protocol: TERMINAL_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: false,
    error,
    code,
  }
}

function send(connection: ClientConnection, frame: TerminalResponse | TerminalDaemonEvent) {
  if (!connection.socket.write(encodeTerminalFrame(frame))) connection.blocked = true
}

function broadcast(event: TerminalDaemonEvent, sessionId?: string) {
  const frame = encodeTerminalFrame(event)
  for (const client of clients) {
    const consumer = sessionId ? client.sessions.get(sessionId) : undefined
    if (sessionId && !consumer) continue
    if (event.type === "output" && consumer && event.sequence <= consumer.snapshotSequence) continue
    // Status/removal must survive socket backpressure too. Output is gated by drainSessionOutput.
    const writable = client.socket.write(frame)
    if (event.type === "output" && consumer) {
      const bytes = Buffer.byteLength(event.data)
      consumer.pendingOutput.set(event.sequence, bytes)
      consumer.pendingBytes += bytes
      reconcileProducerFlow(event.sessionId)
    }
    if (!writable) client.blocked = true
  }
}

function reconcileProducerFlow(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session?.pty) return
  const consumers = [...clients].flatMap((client) => {
    const consumer = client.sessions.get(sessionId)
    return consumer ? [consumer] : []
  })
  const shouldPause = consumers.some(
    (client) => client.pendingBytes >= TERMINAL_FLOW_HIGH_BYTES
  )
  const shouldResume = consumers.every(
    (client) => client.pendingBytes <= TERMINAL_FLOW_LOW_BYTES
  )
  if (!session.flowPaused && shouldPause) {
    try {
      session.pty.pause()
      session.flowPaused = true
    } catch {
      return
    }
  } else if (session.flowPaused && shouldResume) {
    try {
      session.pty.resume()
      session.flowPaused = false
      drainSessionOutput(session)
    } catch {
      return
    }
  }
}

function attachConsumer(connection: ClientConnection, sessionId: string, snapshotSequence: number) {
  connection.sessions.set(sessionId, { pendingOutput: new Map(), pendingBytes: 0, snapshotSequence })
  reconcileProducerFlow(sessionId)
}

function detachConsumer(connection: ClientConnection, sessionId: string) {
  connection.sessions.delete(sessionId)
  reconcileProducerFlow(sessionId)
}

function acknowledgeOutput(connection: ClientConnection, sessionId: string, sequence: number) {
  const consumer = connection.sessions.get(sessionId)
  if (!consumer) return
  for (const [sentSequence, bytes] of consumer.pendingOutput) {
    if (sentSequence > sequence) continue
    consumer.pendingOutput.delete(sentSequence)
    consumer.pendingBytes -= bytes
  }
  reconcileProducerFlow(sessionId)
}

function publishStatus(session: LiveSession) {
  broadcast({
    protocol: TERMINAL_PROTOCOL_VERSION,
    type: "status",
    session: sessionCopy(session.summary),
  })
}

function markDirty() {
  dirty = true
}

function listSessions() {
  return [...sessions.values()]
    .map((session) => sessionCopy(session.summary))
    .sort((left, right) => right.createdAt - left.createdAt)
}

function shellCommand() {
  if (process.platform === "win32") {
    return { file: process.env.COMSPEC ?? "powershell.exe", args: [] }
  }
  return { file: process.env.SHELL ?? "/bin/sh", args: ["-l"] }
}

async function createSession(
  request: Extract<TerminalRequest, { type: "create" }>
) {
  if (sessions.size >= TERMINAL_MAX_SESSIONS) {
    throw new Error(`Terminal session limit reached (${TERMINAL_MAX_SESSIONS})`)
  }
  const now = Date.now()
  const id = randomUUID()
  // A shell in Mako's terminal is the user's, not the host's: it must not
  // inherit the data root and socket the host was launched with.
  const env: NodeJS.ProcessEnv = {
    ...childProcessEnv(process.env),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  }
  delete env.ELECTRON_RUN_AS_NODE
  await prepareMacosTerminalLogin()
  const shell = wrapMacosTerminalLogin(shellCommand(), env)
  const pty = spawnPty(shell.file, shell.args, {
    name: "xterm-256color",
    cwd: request.cwd,
    cols: request.cols,
    rows: request.rows,
    env,
  })
  const session: LiveSession = {
    summary: {
      id,
      title: request.title?.trim() || basename(request.cwd) || "Terminal",
      cwd: request.cwd,
      createdAt: now,
      updatedAt: now,
      status: "running",
      cols: request.cols,
      rows: request.rows,
      sequence: 0,
    },
    history: new BoundedTerminalHistory(),
    historyFilter: new TerminalHistoryFilter((title) => {
      if (session.summary.title === title) return
      session.summary.title = title
      publishStatus(session)
    }),
    pty,
    flowPaused: false,
    pendingOutput: [],
  }
  session.dataListener = pty.onData((data) => receiveOutput(session, data))
  session.exitListener = pty.onExit(({ exitCode }) => finishSession(session, exitCode))
  sessions.set(id, session)
  markDirty()
  publishStatus(session)
  return session
}

function drainSessionOutput(session: LiveSession) {
  const hasConsumer = [...clients].some(
    (client) => client.sessions.has(session.summary.id)
  )
  if (!hasConsumer) {
    session.pendingOutput = []
    return
  }
  while (!session.flowPaused) {
    const transportBlocked = [...clients].some(
      (client) =>
        client.sessions.has(session.summary.id) && client.blocked
    )
    if (transportBlocked) return
    const output = session.pendingOutput.shift()
    if (!output) return
    broadcast(
      {
        protocol: TERMINAL_PROTOCOL_VERSION,
        type: "output",
        sessionId: session.summary.id,
        sequence: output.sequence,
        data: output.data,
      },
      session.summary.id
    )
  }
}

function receiveOutput(session: LiveSession, data: string) {
  for (const chunk of splitTerminalOutput(data)) {
    session.history.append(session.historyFilter.push(chunk))
    session.summary.sequence += 1
    session.summary.updatedAt = Date.now()
    session.pendingOutput.push({
      sequence: session.summary.sequence,
      data: chunk,
    })
  }
  drainSessionOutput(session)
  markDirty()
}

function terminateSession(session: LiveSession) {
  session.dataListener?.dispose()
  session.exitListener?.dispose()
  const pty = session.pty
  session.dataListener = undefined
  session.exitListener = undefined
  session.pty = null
  session.flowPaused = false
  if (!pty) return
  try {
    killTerminalProcessGroups(pty.pid, () => pty.kill())
  } catch {
    try {
      pty.kill()
    } catch {
      return
    }
  }
}

function finishSession(session: LiveSession, exitCode: number) {
  if (sessions.get(session.summary.id) !== session) return
  session.pty = null
  session.flowPaused = false
  session.dataListener?.dispose()
  session.exitListener?.dispose()
  session.dataListener = undefined
  session.exitListener = undefined
  session.summary.status = "exited"
  session.summary.exitCode = exitCode
  session.summary.updatedAt = Date.now()
  markDirty()
  publishStatus(session)
  void persist()
}

function getSession(id: string) {
  const session = sessions.get(id)
  if (!session) throw new Error("Terminal session was not found")
  return session
}

async function handleRequest(connection: ClientConnection, request: TerminalRequest) {
  try {
    if (request.type === "hello") {
      const hello: Extract<TerminalResult, { kind: "hello" }> = {
        kind: "hello",
        daemonVersion: TERMINAL_DAEMON_VERSION,
        pid: process.pid,
      }
      if (build !== undefined) hello.daemonBuild = build
      send(connection, response(request.id, hello, request.protocol))
      return
    }
    if (request.type === "list") {
      send(connection, response(request.id, { kind: "sessions", sessions: listSessions() }))
      return
    }
    if (request.type === "create") {
      const session = await createSession(request)
      send(connection, response(request.id, { kind: "session", session: sessionCopy(session.summary) }))
      return
    }
    if (request.type === "attach") {
      const session = getSession(request.sessionId)
      // This client's snapshot already contains queued output. Other clients
      // still need those frames; attaching must not clear their shared queue.
      attachConsumer(connection, request.sessionId, session.summary.sequence)
      send(
        connection,
        response(request.id, {
          kind: "snapshot",
          snapshot: {
            session: sessionCopy(session.summary),
            data: session.history.text(),
            sequence: session.summary.sequence,
          },
        })
      )
      return
    }
    if (request.type === "detach") {
      detachConsumer(connection, request.sessionId)
      send(connection, response(request.id, { kind: "ok" }))
      return
    }
    if (request.type === "ack") {
      acknowledgeOutput(
        connection,
        request.sessionId,
        request.sequence
      )
      send(connection, response(request.id, { kind: "ok" }))
      return
    }
    if (request.type === "write") {
      const session = getSession(request.sessionId)
      if (!session.pty || session.summary.status !== "running") {
        throw new Error("This terminal is not running. Start a new terminal to continue.")
      }
      session.pty.write(request.data)
      send(connection, response(request.id, { kind: "ok" }))
      return
    }
    if (request.type === "resize") {
      const session = getSession(request.sessionId)
      session.summary.cols = request.cols
      session.summary.rows = request.rows
      session.summary.updatedAt = Date.now()
      session.pty?.resize(request.cols, request.rows)
      markDirty()
      publishStatus(session)
      send(connection, response(request.id, { kind: "ok" }))
      return
    }
    if (request.type === "kill") {
      const session = sessions.get(request.sessionId)
      if (!session) { send(connection, response(request.id, { kind: "ok" })); return }
      terminateSession(session)
      sessions.delete(request.sessionId)
      for (const client of clients) client.sessions.delete(request.sessionId)
      markDirty()
      broadcast({
        protocol: TERMINAL_PROTOCOL_VERSION,
        type: "removed",
        sessionId: request.sessionId,
      })
      send(connection, response(request.id, { kind: "ok" }))
      void persist()
      return
    }
    if (request.type === "replace") {
      await persist(true)
      send(
        connection,
        response(request.id, { kind: "ok" }, request.protocol)
      )
      setTimeout(() => void shutdown(0), 25)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = message.includes("limit") ? "limit" : message.includes("not found") ? "not-found" : "invalid-request"
    send(connection, failure(request.id, message, code))
  }
}

function accept(socket: Socket) {
  socket.setNoDelay(true)
  const connection: ClientConnection = {
    socket,
    decoder: new JsonLineDecoder(),
    blocked: false,
    sessions: new Map(),
  }
  clients.add(connection)
  socket.on("drain", () => {
    connection.blocked = false
    for (const sessionId of connection.sessions.keys()) {
      const session = sessions.get(sessionId)
      if (session) drainSessionOutput(session)
    }
  })
  socket.on("data", (chunk) => {
    try {
      for (const value of connection.decoder.push(chunk)) {
        const request = parseTerminalRequest(value)
        if (request) void handleRequest(connection, request)
        else send(connection, failure(0, "Invalid terminal protocol request"))
      }
    } catch (error) {
      send(connection, failure(0, error instanceof Error ? error.message : String(error)))
      socket.destroy()
    }
  })
  const drop = () => {
    clients.delete(connection)
    for (const sessionId of connection.sessions.keys()) reconcileProducerFlow(sessionId)
  }
  socket.on("close", drop)
  socket.on("error", drop)
}

async function persist(force = false) {
  if (saving) {
    await saving
    if (!force || !dirty) return
  }
  if (!dirty && !force) return
  dirty = false
  const state: PersistedState = {
    version: TERMINAL_PROTOCOL_VERSION,
    savedAt: Date.now(),
    sessions: [...sessions.values()].map((session) => ({
      summary: sessionCopy(session.summary),
      history: session.history.base64(),
    })),
  }
  saving = writeFile(historyTemp, JSON.stringify(state), { mode: 0o600 })
    .then(() => rename(historyTemp, historyFile))
    .catch(() => {
      dirty = true
    })
    .finally(() => {
      saving = null
    })
  return saving
}

async function restore() {
  try {
    const parsed = persistedStateSchema.safeParse(
      JSON.parse(await readFile(historyFile, "utf8"))
    )
    if (!parsed.success) return
    for (const saved of parsed.data.sessions) {
      const history = new BoundedTerminalHistory()
      const legacy = new BoundedTerminalHistory()
      legacy.restore(saved.history)
      const historyFilter = new TerminalHistoryFilter()
      history.append(historyFilter.push(legacy.text()))
      sessions.set(saved.summary.id, {
        summary: {
          ...saved.summary,
          status:
            saved.summary.status === "running"
              ? "interrupted"
              : saved.summary.status,
        },
        history,
        historyFilter,
        pty: null,
        flowPaused: false,
        pendingOutput: [],
      })
    }
  } catch {
    return
  }
}

function probe(path: string) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(path)
    const done = (active: boolean) => {
      socket.destroy()
      resolve(active)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

function listen(instance: Server) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    instance.once("error", onError)
    instance.listen(endpoint, () => {
      instance.off("error", onError)
      resolve()
    })
  })
}

async function startServer() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700)
  await restore()
  const instance = createServer(accept)
  try {
    await listen(instance)
  } catch (error) {
    const parsed = errnoSchema.safeParse(error)
    const code = parsed.success ? parsed.data.code : ""
    if (process.platform === "win32" || code !== "EADDRINUSE") throw error
    if (await probe(endpoint)) return
    await unlink(endpoint).catch(() => undefined)
    await listen(instance)
  }
  server = instance
  if (process.platform !== "win32") {
    await chmod(endpoint, 0o600)
    watchEndpoint((await lstat(endpoint)).ino)
  }
  setInterval(() => void persist(), 2_000)
}

/**
 * A daemon whose socket path was unlinked or rebound by a successor can
 * never be reached again, yet it kept its shells, its CPU and a timer that
 * rewrote the successor's history file every two seconds. It leaves instead,
 * without touching the files that now belong to the new owner.
 */
function watchEndpoint(inode: number) {
  const timer = setInterval(() => {
    void lstat(endpoint)
      .then((info) => info.ino !== inode)
      .catch((error) => errnoSchema.safeParse(error).data?.code === "ENOENT")
      .then((orphaned) => {
        if (orphaned) void shutdown(0, "orphaned")
      })
  }, ENDPOINT_CHECK_MS)
  timer.unref()
}

async function shutdown(code: number, reason: "stop" | "orphaned" = "stop") {
  if (stopping) return
  stopping = true
  const owned = reason === "stop"
  if (owned) await persist(true).catch(() => undefined)
  for (const session of sessions.values()) terminateSession(session)
  for (const client of clients) client.socket.destroy()
  // Closing a Unix socket server unlinks its path, which a successor may own.
  if (owned) server?.close()
  if (owned && process.platform !== "win32") await unlink(endpoint).catch(() => undefined)
  process.exit(code)
}

process.title = "mako-terminal-daemon"
process.on("SIGTERM", () => void shutdown(0))
process.on("SIGINT", () => void shutdown(0))
process.on("uncaughtException", () => void shutdown(1))
process.on("unhandledRejection", () => void shutdown(1))

void startServer().catch(() => void shutdown(1))
