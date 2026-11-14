import { timingSafeEqual } from "node:crypto"
import type { IncomingHttpHeaders } from "node:http"

/** The header the host sends its hub's token in. */
export const HUB_TOKEN_HEADER = "x-mako-hub"

const HELPER = /^\/helper\/([0-9A-Fa-f-]{36})\/(stream\.avcc|stream\.mjpeg|config|health|ax)$/
const UDID = /^[0-9A-Fa-f-]{36}$/
const INSPECTOR_PAGE = /^\/inspector\/page\/([^/]+)$/
const SIMULATOR_SOCKET = /com\.apple\.webinspectord_sim\.socket\b/

/**
 * Whether a request is the hub's host's own: the exact loopback Host it was started on (so a page that rebinds a name
 * to 127.0.0.1 is refused), nothing a browser adds to every request a page makes (Origin, `Sec-Fetch-Site`), and the
 * token. Anything else is refused before a tool sees it. Node's own `fetch` sends `Sec-Fetch-Mode` but never the site.
 */
export function admitted(headers: IncomingHttpHeaders, host: string, token: Buffer): boolean {
  if (headers.host !== host) return false
  if (headers.origin !== undefined || headers["sec-fetch-site"] !== undefined) return false
  const given = headers[HUB_TOKEN_HEADER]
  if (given === undefined || Array.isArray(given)) return false
  const bytes = Buffer.from(given)
  return bytes.length === token.length && timingSafeEqual(bytes, token)
}

export type HubRoute =
  | { kind: "health" }
  | { kind: "helper"; udid: string; path: string }
  | { kind: "targets" }
  | { kind: "not-found" }

/** What a GET is for; serve-sim sees only the helper routes Mako reads, never its `/api`, `/exec`, grid or DevTools. */
export function hubRoute(method: string | undefined, url: URL): HubRoute {
  if (method !== "GET") return { kind: "not-found" }
  if (url.pathname === "/health") return { kind: "health" }
  if (url.pathname === "/inspector/targets") return { kind: "targets" }
  const helper = HELPER.exec(url.pathname)
  if (helper) return { kind: "helper", udid: helper[1]!, path: url.pathname }
  return { kind: "not-found" }
}

export type HubUpgrade = { kind: "touch"; udid: string } | { kind: "inspector"; target: string } | { kind: "not-found" }

export function hubUpgrade(url: URL): HubUpgrade {
  const device = url.searchParams.get("device")
  if (url.pathname === "/helper/ws" && device && UDID.test(device)) return { kind: "touch", udid: device }
  const page = INSPECTOR_PAGE.exec(url.pathname)
  if (page) return { kind: "inspector", target: decodeURIComponent(page[1]!) }
  return { kind: "not-found" }
}

/** A target's kind as DevTools names it: inspect-webkit lists Safari's tabs as `WIRTypeWebPage`, and maps them so too. */
export function inspectorType(wir: string): "page" | "worker" | "service_worker" {
  if (wir === "WIRTypeServiceWorker") return "service_worker"
  if (wir === "WIRTypeWorker" || wir === "WIRTypeJavaScript") return "worker"
  return "page"
}

/** Which simulators have a web inspector socket, and which simulator a process on one of them belongs to. */
export interface InspectorSockets {
  /** Changes when a simulator's socket appears or goes, so the bridge starts again only then. */
  key: string
  /** The `launchd_sim` that holds the socket a pid was seen on, or that pid when it held none. */
  simulator: (pid: number) => number
}

/**
 * The simulators with a web inspector socket, from `lsof -U -F pcn`. inspect-webkit names a simulator by whichever
 * process `lsof` listed last on its socket, which may be one of the simulator's own that's gone a moment later;
 * `simulator` turns that into the `launchd_sim` it ran under.
 */
export function inspectorSockets(lsof: string): InspectorSockets {
  const holders = new Map<string, Set<number>>()
  const launchd = new Map<string, number>()
  let pid = 0
  let command = ""
  for (const line of lsof.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("c")) command = line.slice(1)
    else if (line.startsWith("n") && SIMULATOR_SOCKET.test(line)) {
      const path = line.slice(1)
      holders.set(path, (holders.get(path) ?? new Set()).add(pid))
      if (command === "launchd_sim") launchd.set(path, pid)
    }
  }
  const key = [...holders].map(([path, pids]) => `${launchd.get(path) ?? Math.min(...pids)}:${path}`)
  return {
    key: key.sort().join("\n"),
    simulator: (holder) => {
      for (const [path, pids] of holders) if (pids.has(holder)) return launchd.get(path) ?? holder
      return holder
    },
  }
}

/** A WebSocket handshake for inspect-webkit's socket file: the client's own headers, less the Host and token. */
export function upstreamHandshake(path: string, rawHeaders: readonly string[]): string {
  const lines = [`GET ${path} HTTP/1.1`, "Host: 127.0.0.1"]
  for (let at = 0; at + 1 < rawHeaders.length; at += 2) {
    const name = rawHeaders[at]!
    if (name.toLowerCase() !== "host" && name.toLowerCase() !== HUB_TOKEN_HEADER) lines.push(`${name}: ${rawHeaders[at + 1]}`)
  }
  return `${lines.join("\r\n")}\r\n\r\n`
}
