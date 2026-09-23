import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import { z } from "zod"
import type { ControlPreviews } from "./control-previews.js"
import {
  ComputerObservationSchema,
  ControlImageSchema,
} from "./contracts/control-preview.js"
import { BrowserTargetSchema } from "./contracts/browser-control.js"
import { BrowserService } from "./browser-service.js"
import {
  BrowserCommandSchema,
  BrowserFault,
} from "./contracts/browser-control.js"

export interface ControlCredentials {
  url: string
  token: string
}
interface Scope {
  conversationId: string
  bindingId: string
  expiresAt: number
}
async function body(
  request: IncomingMessage,
  limit = 256 * 1024
): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error("Control request is too large")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export async function startControlService(
  browser: BrowserService,
  authorize: (conversationId: string, bindingId: string) => void,
  previews?: ControlPreviews
) {
  const scopes = new Map<string, Scope>()
  const latestControlToken = new Map<string, string>()
  const inFlight = new Map<string, Set<AbortController>>()
  const refreshLatest = (bindingId: string): boolean => {
    const remaining = [...scopes]
      .reverse()
      .find(([, scope]) => scope.bindingId === bindingId)
    if (remaining) {
      latestControlToken.set(bindingId, remaining[0])
      return true
    }
    latestControlToken.delete(bindingId)
    return false
  }
  const assertScope = (token: string, scope: Scope): void => {
    if (scopes.get(token) !== scope || scope.expiresAt < Date.now())
      throw new Error(
        "This Mako control grant is no longer active. Resume the task in Mako."
      )
    authorize(scope.conversationId, scope.bindingId)
  }
  const server = createServer((request, response) => {
    const abort = new AbortController()
    response.once("close", () => abort.abort())
    let requestToken: string | undefined
    void (async () => {
      if (
        request.method !== "POST" ||
        ![
          "/browser",
          "/browser/release-owner",
          "/computer-observation",
        ].includes(request.url ?? "") ||
        request.headers.origin
      ) {
        response.writeHead(403).end()
        return
      }
      const token = request.headers.authorization?.replace(/^Bearer /, "")
      const scope = token ? scopes.get(token) : undefined
      if (!token || !scope || scope.expiresAt < Date.now()) {
        response.writeHead(401).end()
        return
      }
      requestToken = token
      const running = inFlight.get(token) ?? new Set<AbortController>()
      running.add(abort)
      inFlight.set(token, running)
      assertScope(token, scope)
      if (request.url === "/browser/release-owner") {
        const isLatest =
          latestControlToken.get(scope.bindingId) === token
        scopes.delete(token)
        const hasReplacement = refreshLatest(scope.bindingId)
        const value = isLatest && !hasReplacement
          ? await browser.releaseOwner(scope.bindingId)
          : { released: 0, closed: 0 }
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: true, value }))
        return
      }
      if (request.url === "/computer-observation") {
        const observation = ComputerObservationSchema.parse(
          JSON.parse(await body(request, 9 * 1024 * 1024))
        )
        assertScope(token, scope)
        previews?.observe(
          {
            conversationId: scope.conversationId,
            kind: "computer",
            operation: observation.operation,
            target: observation.target,
            status: observation.status,
          },
          observation.image
        )
        if (observation.window)
          previews?.computerTarget(
            scope.conversationId,
            observation.window,
            () => assertScope(token, scope)
          )
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: true, value: null }))
        return
      }
      const command = BrowserCommandSchema.parse(
        JSON.parse(await body(request))
      )
      assertScope(token, scope)
      const target =
        "target" in command
          ? `${command.target.browser}:${command.target.tab}`
          : "browser" in command
            ? command.browser ?? "Preferred browser"
            : "Browser"
      const tracksActivity = ![
        "status",
        "tabs",
        "events",
        "connect",
        "attach",
        "release",
      ].includes(command.action)
      if (tracksActivity)
        previews?.observe({
          conversationId: scope.conversationId,
          kind: "browser",
          operation: command.action,
          target,
          status: "running",
        })
      const value = await browser
        .execute(scope.bindingId, command, abort.signal, () => {
          assertScope(token, scope)
        })
        .catch((error) => {
          if (tracksActivity)
            previews?.observe({
              conversationId: scope.conversationId,
              kind: "browser",
              operation: command.action,
              target,
              status: "error",
            })
          throw error
        })
      if (tracksActivity) {
        const bound =
          "target" in command
            ? command.target
            : BrowserTargetSchema.safeParse(value).data
        previews?.observe(
          {
            conversationId: scope.conversationId,
            kind: "browser",
            operation: command.action,
            target: bound ? `${bound.browser}:${bound.tab}` : target,
            status: "observed",
          },
          command.action === "screenshot"
            ? ControlImageSchema.safeParse(value).data
            : undefined
        )
        if (bound && command.action !== "close")
          previews?.browserTarget(scope.conversationId, bound, () =>
            assertScope(token, scope), scope.bindingId
          )
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, value }))
    })()
      .catch((error) => {
        if (response.destroyed) return
        const fault =
          error instanceof BrowserFault
            ? error.detail
            : {
                code: "invalid-request",
                message:
                  error instanceof Error
                    ? error.message
                    : "Control request failed",
                outcome: "not-dispatched",
              }
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: false, fault }))
      })
      .finally(() => {
        if (!requestToken) return
        const running = inFlight.get(requestToken)
        running?.delete(abort)
        if (!running?.size) inFlight.delete(requestToken)
      })
  })
  server.requestTimeout = 70_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const { port } = z.object({ port: z.number() }).parse(server.address())
  return {
    mint(conversationId: string, bindingId: string): ControlCredentials {
      for (const [token, scope] of scopes)
        if (scope.expiresAt < Date.now()) {
          scopes.delete(token)
          if (latestControlToken.get(scope.bindingId) === token)
            refreshLatest(scope.bindingId)
        }
      const token = randomBytes(32).toString("base64url")
      scopes.set(token, {
        conversationId,
        bindingId,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      })
      latestControlToken.set(bindingId, token)
      return { url: `http://127.0.0.1:${port}/browser`, token }
    },
    async revoke(conversationId: string, bindingId: string): Promise<void> {
      let removedLatest = false
      for (const [token, scope] of scopes) {
        if (
          scope.conversationId !== conversationId ||
          scope.bindingId !== bindingId
        )
          continue
        scopes.delete(token)
        for (const controller of inFlight.get(token) ?? [])
          controller.abort()
        inFlight.delete(token)
        if (latestControlToken.get(bindingId) === token)
          removedLatest = true
      }
      const hasReplacement = refreshLatest(bindingId)
      if (removedLatest && !hasReplacement)
        await browser.releaseOwner(bindingId)
    },
    close() {
      for (const controllers of inFlight.values())
        for (const controller of controllers) controller.abort()
      inFlight.clear()
      scopes.clear()
      latestControlToken.clear()
      server.closeAllConnections()
      server.close()
      previews?.close()
      browser.close()
    },
  }
}
