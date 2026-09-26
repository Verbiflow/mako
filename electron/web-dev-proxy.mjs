import { request as hostRequest } from "node:http"
import { z } from "zod"

/** The names a browser may give the loopback interface Vite listens on. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"]

/**
 * The origins a page served from these local URLs may present. Vite binds
 * `127.0.0.1` and reports only that name, but a tab opened at `localhost:5173`
 * reaches the same listener and sends `Origin: http://localhost:5173`; every
 * loopback spelling of a loopback URL is that same page.
 */
export function trustedLocalOrigins(urls) {
  const origins = new Set()
  for (const text of urls) {
    const url = new URL(text)
    origins.add(url.origin)
    if (!LOOPBACK_HOSTS.includes(url.hostname === "::1" ? "[::1]" : url.hostname)) continue
    const port = url.port ? `:${url.port}` : ""
    for (const host of LOOPBACK_HOSTS) origins.add(`${url.protocol}//${host}${port}`)
  }
  return origins
}

const MAX_CALL_BYTES = 32 * 1024 * 1024

const CallChannelSchema = z.object({ channel: z.string().regex(/^mako:[a-z0-9-]+$/) })

/** The channel a call names, or undefined when the body is not a call. */
function callChannel(body) {
  try {
    return CallChannelSchema.safeParse(JSON.parse(body.toString("utf8"))).data?.channel
  } catch {
    return undefined
  }
}

/**
 * Same-origin browser access; the host itself is reachable only over a private socket.
 *
 * `refuse`, when given, names why a call may not be forwarded. The body is read
 * whole, checked, and the same bytes are forwarded, so the host parses exactly
 * what was checked. A fixture host refuses the same calls again itself.
 */
export function webHostProxy(socket, { refuse } = {}) {
  const configure = (server) => {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/__mako/")) return next()
        const origins = trustedLocalOrigins(server.resolvedUrls?.local ?? [])
        const path = request.url.slice("/__mako".length)
        const preview = request.method === "GET" && path.startsWith("/file/")
        let origin = request.headers.origin
        if (preview) {
          try {
            origin = new URL(request.headers.referer).origin
          } catch {
            origin = undefined
          }
        }
        const trusted =
          origins.has(origin) &&
          request.headers["sec-fetch-site"] === "same-origin"
        if (
          !trusted ||
          (!preview &&
            (request.method !== "POST" ||
              request.headers["x-mako-client"] !== "web"))
        ) {
          response
            .writeHead(403)
            .end("Mako web access requires this page's origin")
          return
        }
        if (!preview && path !== "/rpc" && path !== "/events") {
          response.writeHead(404).end()
          return
        }
        const headers = { "content-type": "application/json" }
        if (request.headers.accept === "application/vnd.mako.preview.v1") headers.accept = request.headers.accept
        if (request.headers["x-mako-window"]) headers["x-mako-window"] = request.headers["x-mako-window"]
        if (request.headers["x-mako-history"] === "1") headers["x-mako-history"] = "1"
        if (preview && request.headers.range)
          headers.range = request.headers.range
        const open = () => {
          const upstream = hostRequest(
            {
              socketPath: socket,
              path,
              method: request.method,
              headers,
            },
            (result) => {
              response.writeHead(result.statusCode ?? 502, {
                ...result.headers,
                "cache-control": "no-store",
              })
              result.on("error", () => response.destroy())
              result.pipe(response)
            }
          )
          upstream.on("error", () => {
            if (!response.headersSent) response.writeHead(503)
            response.end("The Mako host connection was interrupted; delivery is unconfirmed")
          })
          response.once("close", () => upstream.destroy())
          return upstream
        }
        if (!refuse || path !== "/rpc") {
          request.pipe(open())
          return
        }
        const chunks = []
        let bytes = 0
        request.on("data", (chunk) => {
          bytes += chunk.length
          if (bytes > MAX_CALL_BYTES) {
            if (!response.headersSent) response.writeHead(413, { connection: "close" }).end()
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        request.on("error", () => response.destroy())
        request.on("end", () => {
          if (bytes > MAX_CALL_BYTES) return
          const body = Buffer.concat(chunks)
          const channel = callChannel(body)
          const refusal = channel === undefined ? "The fixture desk refused a request that names no host call." : refuse(channel)
          if (!refusal) {
            open().end(body)
            return
          }
          response
            .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
            .end(JSON.stringify({ ok: false, error: refusal, code: "fixture-refused" }))
        })
      })
  }
  return { name: "mako-real-host", configureServer: configure, configurePreviewServer: configure }
}
