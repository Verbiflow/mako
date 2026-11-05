import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { Server, createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { connect, type Socket } from "node:net"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { admitted, hubRoute, hubUpgrade, inspectorSockets, inspectorType, upstreamHandshake } from "./simulator-hub.js"

/**
 * Mako's simulator hub: serve-sim's capture and touch, and inspect-webkit's bridge to Safari's web inspector, in one
 * process the host starts on a loopback port. Neither tool's own server is run. serve-sim's preview server answers
 * `/api` (which hands out the token for its shell route) and `/exec` to anyone on the port, with CORS `*` and no Host
 * check, and inspect-webkit 0.0.5 binds every interface when asked for loopback. So this serves their routes itself,
 * to its host alone (see `admitted`), and inspect-webkit's server listens on a socket file in the host's own folder
 * (or this user's temporary folder, when that path is too long to bind).
 *
 *   MAKO_SIMULATOR_HUB_TOKEN=<token> node simulator-hub-entry.js --port <port> --serve-sim <package> --inspect-webkit <package> --socket <file>
 */

process.title = "mako-simulator-hub"

/** How long a reading of which simulators have an inspector socket holds. */
const SOCKETS_MS = 2_000
/** A bridge just started hears each simulator's pages a moment later: its first answer waits this long for them. */
const LISTING_MS = 2_000

interface SimMiddleware {
  (req: IncomingMessage, res: ServerResponse, next?: () => void): void
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void
}

interface CdpTarget {
  targetId: string
  source: { kind: "device" | "simulator"; id: string }
  appName: string
  bundleId?: string
  title: string
  url: string
  type: string
  inUseByOtherInspector: boolean
}

interface CdpServer {
  stop(): void
  getTargets(): CdpTarget[]
}

function argument(name: string): string {
  const at = process.argv.indexOf(`--${name}`)
  const value = at === -1 ? undefined : process.argv[at + 1]
  if (!value) throw new Error(`--${name} is required`)
  return value
}

const port = Number(argument("port"))
const serveSim = argument("serve-sim")
const inspectWebkit = argument("inspect-webkit")
const socketFile = argument("socket")
const token = Buffer.from(process.env.MAKO_SIMULATOR_HUB_TOKEN ?? "")
delete process.env.MAKO_SIMULATOR_HUB_TOKEN
if (token.length < 32) throw new Error("MAKO_SIMULATOR_HUB_TOKEN is required")
const origin = `127.0.0.1:${port}`

const middleware: SimMiddleware = (await import(pathToFileURL(join(serveSim, "dist", "middleware.js")).href)).simMiddleware({ basePath: "/", proxyHelpers: true })
const startCdpServer: (options: { port: number; host: string }) => Promise<CdpServer> = (await import(pathToFileURL(join(inspectWebkit, "dist", "index.js")).href)).startCdpServer

type Sockets = ReturnType<typeof inspectorSockets>
/** `sockets` is what the bridge started over; `held`, read as it started, names the processes it saw on them. */
type Inspector = { server: CdpServer; sockets: Sockets; held: Sockets }

let inspector: Inspector | undefined
let inspectorStarting: Promise<Inspector> | undefined
let sockets: { at: number; found: Sockets } | undefined

function simulatorSockets(fresh = false): Sockets {
  if (!fresh && sockets && Date.now() - sockets.at < SOCKETS_MS) return sockets.found
  const listed = spawnSync("/usr/sbin/lsof", ["-U", "-F", "pcn"], { encoding: "utf8", timeout: 10_000 })
  sockets = { at: Date.now(), found: inspectorSockets(listed.stdout ?? "") }
  return sockets.found
}

/** inspect-webkit's bridge over the simulators running now: it finds them only as it starts, so it starts again when they change. */
async function inspectorServer(): Promise<Inspector> {
  const now = simulatorSockets()
  if (inspector && inspector.sockets.key === now.key) return inspector
  if (inspectorStarting) return inspectorStarting
  inspectorStarting = (async () => {
    inspector?.server.stop()
    inspector = undefined
    rmSync(socketFile, { force: true })
    const listen = Server.prototype.listen
    // SAFETY: inspect-webkit calls `listen(options, ready)`, its callback last; the socket file takes the options' place.
    Server.prototype.listen = function (this: Server, ...args: Array<() => void>) {
      return listen.call(this, socketFile, args.at(-1))
    } as typeof listen
    let server: CdpServer
    try {
      server = await startCdpServer({ port: 1, host: "127.0.0.1" })
    } finally {
      Server.prototype.listen = listen
    }
    const held = simulatorSockets(true)
    for (const started = Date.now(); now.key && !server.getTargets().length && Date.now() - started < LISTING_MS; )
      await new Promise((resolve) => setTimeout(resolve, 100))
    inspector = { server, sockets: now, held }
    return inspector
  })().finally(() => (inspectorStarting = undefined))
  return inspectorStarting
}

type Answer = { ok: true; pid: number } | { error: string } | ReturnType<typeof targets>

function answer(res: ServerResponse, status: number, body: Answer): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) })
  res.end(text)
}

function targets({ server, held }: Inspector) {
  return server
    .getTargets()
    .filter((target) => target.source.kind === "simulator")
    .map((target) => ({
      id: target.targetId,
      pid: held.simulator(Number(target.source.id.replace(/^sim:/, ""))),
      app: target.appName,
      bundleId: target.bundleId,
      title: target.title,
      url: target.url,
      type: inspectorType(target.type),
      inUse: target.inUseByOtherInspector,
    }))
}

const server = createServer((req, res) => {
  if (!admitted(req.headers, origin, token)) return answer(res, 403, { error: "forbidden" })
  const route = hubRoute(req.method, new URL(req.url ?? "/", `http://${origin}`))
  switch (route.kind) {
    case "health":
      return answer(res, 200, { ok: true, pid: process.pid })
    case "helper":
      req.url = route.path
      return middleware(req, res, () => answer(res, 404, { error: "not found" }))
    case "targets":
      return void inspectorServer().then(
        (inspector) => answer(res, 200, targets(inspector)),
        (error) => answer(res, 502, { error: error instanceof Error ? error.message : String(error) })
      )
    case "not-found":
      return answer(res, 404, { error: "not found" })
  }
})

server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
  if (!admitted(req.headers, origin, token)) return void socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
  const upgrade = hubUpgrade(new URL(req.url ?? "/", `http://${origin}`))
  switch (upgrade.kind) {
    case "touch":
      req.url = `/helper/ws?device=${upgrade.udid}`
      return middleware.handleUpgrade(req, socket, head)
    case "inspector":
      return void inspectorServer().then(
        () => bridge(req, socket, head, `/devtools/page/${encodeURIComponent(upgrade.target)}`),
        () => socket.destroy()
      )
    case "not-found":
      return void socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
  }
})

/** A WebSocket passed on to inspect-webkit's socket file, and its bytes both ways after the handshake. */
function bridge(req: IncomingMessage, socket: Socket, head: Buffer, path: string): void {
  const upstream = connect({ path: socketFile })
  const close = () => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.once("connect", () => {
    upstream.write(upstreamHandshake(path, req.rawHeaders))
    if (head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  for (const end of [upstream, socket]) {
    end.once("error", close)
    end.once("close", close)
  }
}

function quit(): void {
  inspector?.server.stop()
  rmSync(socketFile, { force: true })
  process.exit(0)
}

// Its host holds its stdin: when that closes, however the host ended, so does the hub.
process.stdin.on("close", quit)
process.stdin.resume()
process.on("SIGTERM", quit)
process.on("SIGINT", quit)
server.listen(port, "127.0.0.1")
