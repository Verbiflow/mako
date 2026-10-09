import { controlAgent } from "./control-agent.js"
import { createServer } from "node:http"
import type { Server, Socket } from "node:net"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { createControlDirectory, createPrivateControlSocket } from "./private-socket.js"
import {
  controlClient,
  controlFaultData,
  ControlFault,
  controlInput,
  type ControlLocator,
  type ExecutionReceipt,
  RecordingReceiptSchema,
  TabHandle,
  type ControlTarget,
  type ElementExpectation,
} from "@mako/control/control"
import { ControlProgramError, effectText, spillImage, type ControlEffect, type ControlProgramOutput } from "@mako/control/program"
import type { ControlSession } from "./control-session.js"
import {
  CONTROL_SESSION_PROTOCOL,
  controlSessionBuild,
  SessionRequestSchema,
  type SessionDescriptor,
  type SessionOperation,
} from "./control-session-protocol.js"

const engineBuild = controlSessionBuild()

/** Dispatch one ref-free `act` step on the element its locator resolves. */
function act(
  locator: ControlLocator,
  step: Extract<SessionOperation, { method: "act" }>["operation"]
): Promise<ExecutionReceipt> {
  switch (step.kind) {
    case "set-text":
      return locator.setValue(step.text)
    case "activate":
      return locator.click()
    case "press-key":
      return locator.pressKey(step.key, { modifiers: step.modifiers })
    case "select-option":
      return locator.selectOption(
        step.label === undefined ? { value: step.value! } : { label: step.label }
      )
  }
}
// Preserve load-time identity; transport startup reports a missing payload.
void engineBuild.catch(() => {})

/** The socket borrows one engine. Closing a request never closes its session. */
export async function serveControlSession(
  session: ControlSession,
  options: { onStop?: () => void; directory?: string } = {}
) {
  const build = await engineBuild
  const directory = options.directory ?? await createControlDirectory("mako-control-")
  if (options.directory) await mkdir(directory, { mode: 0o700 })
  await chmod(directory, 0o700)
  const endpoint = await createPrivateControlSocket(directory, "session.sock")
  const socket = endpoint.path
  const file = join(directory, "session.json")
  const descriptor: SessionDescriptor = {
    protocol: CONTROL_SESSION_PROTOCOL,
    build,
    session: randomUUID(),
    socket,
    pid: process.pid,
  }
  const transport = controlSessionTransport(session, descriptor, () => {
    void close().then(() => options.onStop?.())
  })
  let closing: Promise<void> | undefined
  async function close(): Promise<void> {
    return (closing ??= (async () => {
      try {
        await transport.close()
      } finally {
        try {
          await endpoint.close()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    })())
  }
  try {
    await new Promise<void>((resolve, reject) => {
      transport.server.once("error", reject)
      transport.server.listen(socket, resolve)
    })
    await chmod(socket, 0o600)
    await writeFile(file, JSON.stringify(descriptor) + "\n", {
      mode: 0o600,
      flag: "wx",
    })
    return { file, descriptor, close }
  } catch (error) {
    await close()
    throw error
  }
}

/**
 * Serve a session on a socket another process listens on and handed over,
 * with the connections that arrived before the handover. The files are the
 * listener's owner's; closing ends the session and stops accepting here.
 */
export function serveHandedControlSession(
  session: ControlSession,
  options: { descriptor: SessionDescriptor; listener: Server; onStop?: () => void }
) {
  let closing: Promise<void> | undefined
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      options.listener.close()
      await transport.close()
    })())
  const transport = controlSessionTransport(session, options.descriptor, () => {
    void close().then(() => options.onStop?.())
  })
  const accept = (connection: Socket) => {
    transport.server.emit("connection", connection)
    connection.resume()
  }
  options.listener.on("connection", accept)
  return { accept, close }
}

/** Answer each request on a connection with a fault; nothing reaches an engine. */
export function refuseControlConnection(connection: Socket, fault: { code: string; message: string }) {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) request.destroy()
      else chunks.push(chunk)
    })
    request.once("end", () => {
      let requestId = "invalid"
      try {
        requestId = z.object({ requestId: z.string() }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).requestId
      } catch { /* a malformed request still gets its refusal */ }
      response
        .writeHead(200, { "content-type": "application/json", connection: "close" })
        .end(JSON.stringify({ ok: false, requestId, fault: { ...fault, outcome: "not-dispatched" } }))
    })
  })
  connection.once("close", () => server.close())
  server.emit("connection", connection)
  connection.resume()
}

function controlSessionTransport(session: ControlSession, descriptor: SessionDescriptor, stop: () => void) {
  const requests = new Set<AbortController>()
  const diagnostics: Array<{
    requestId: string
    method: string
    outcome: string
    ms: number
  }> = []
  let closing: Promise<void> | undefined
  let stopped = false
  function sdkHandle(target: ControlTarget, signal: AbortSignal) {
    const client = controlClient((action, args) =>
      session.call({ action, ...args }, signal)
    )
    return target.kind === "page" ? client.tab(target) : client.window(target)
  }
  async function invoke(operation: SessionOperation, signal: AbortSignal) {
    switch (operation.method) {
      case "status":
        return session.status()
      case "help":
        return session.help(operation.args)
      case "diagnostics":
        return { ...session.diagnostics(), requests: [...diagnostics] }
      case "js-reset":
      case "js":
        return controlAgent(session)(operation, signal)
      case "exec": {
        let blocks: Awaited<ReturnType<typeof session.execute>>
        let failure: Error | undefined
        let effects: readonly ControlEffect[] = []
        try {
          blocks = await session.execute(
            { source: operation.source },
            signal,
            { yield: false }
          )
        } catch (error) {
          if (!(error instanceof ControlProgramError) || !error.output.length) throw error
          blocks = error.output
          failure = error.cause
          effects = error.effects
        }
        const output: ControlProgramOutput[] = []
        for (const block of blocks) {
          if (block.type !== "image") {
            output.push(block)
            continue
          }
          try {
            const directory = z
              .object({ artifacts: z.string() })
              .parse(await session.status()).artifacts
            const receipt = await spillImage(
              directory,
              "script-image",
              block.data,
              block.mimeType
            )
            output.push({
              type: "text",
              text: JSON.stringify({
                ...receipt,
                note: "Explicit script image saved for shell tools.",
              }),
            })
          } catch (error) {
            // The program's own fault outranks a lost image receipt.
            if (!failure) throw error
            output.push({
              type: "text",
              text: JSON.stringify({ image: "unsaved", reason: error instanceof Error ? error.message : String(error) }),
            })
          }
        }
        if (failure) throw new ControlProgramError(output, failure, effects)
        return output
      }
      case "call":
        return session.call(operation.command, signal)
      case "shot": {
        const handle = sdkHandle(operation.target, signal)
        return operation.selector
          ? handle.locator(operation.selector).screenshot(operation.options)
          : handle.screenshot(operation.options)
      }
      case "act":
        return act(
          sdkHandle(operation.target, signal).locator(operation.selector),
          operation.operation
        )
      case "expect":
        return z
          .json()
          .parse(
            await sdkHandle(operation.target, signal).expect(
              // SAFETY: `expect` parses the expectation with its own schema and reports a malformed one as invalid-request before anything runs.
              operation.expectation as ElementExpectation,
              operation.options
            )
          )
      case "close": {
        const handle = sdkHandle(operation.target, signal)
        if (!(handle instanceof TabHandle))
          throw new ControlFault(
            "unsupported",
            "close closes a task-owned browser tab. Native windows stay open; nothing was dispatched.",
            "not-dispatched"
          )
        return handle.close()
      }
      case "record": {
        const command: Omit<
          Extract<SessionOperation, { method: "record" }>,
          "method" | "wait"
        > & { action: "recording" } = {
          action: "recording",
          target: operation.target,
          operation: operation.operation,
        }
        if (operation.id) command.id = operation.id
        if (operation.options) command.options = operation.options
        let receipt = RecordingReceiptSchema.parse(
          await session.call(command, signal)
        )
        while (
          operation.operation === "stop" &&
          operation.wait &&
          receipt.status === "finalizing"
        ) {
          await delay(100, undefined, { signal })
          receipt = RecordingReceiptSchema.parse(
            await session.call(
              {
                action: "recording",
                target: operation.target,
                operation: "status",
                id: receipt.id,
              },
              signal
            )
          )
        }
        return receipt
      }
      case "stop":
        stopped = true
        for (const request of requests)
          if (request.signal !== signal) request.abort()
        await session.close()
        return { stopped: true }
    }
  }
  const server = createServer((request, response) => {
    const controller = new AbortController()
    requests.add(controller)
    response.once("close", () => {
      if (!response.writableFinished) controller.abort()
    })
    const started = performance.now()
    let requestId = "invalid"
    let method = "invalid"
    let outcome = "not-dispatched"
    void (async () => {
      if (stopped)
        throw new ControlFault(
          "session-closed",
          "This session has stopped.",
          "not-dispatched"
        )
      if (
        request.method !== "POST" ||
        request.url !== "/request" ||
        request.headers.origin
      )
        throw new ControlFault(
          "invalid-request",
          "Use the private Local Control client protocol.",
          "not-dispatched"
        )
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > 1024 * 1024)
          throw new ControlFault(
            "input-limit",
            "Request exceeds 1 MiB.",
            "not-dispatched"
          )
        chunks.push(buffer)
      }
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      requestId = z
        .object({ requestId: z.string().uuid() })
        .parse(raw).requestId
      const input = controlInput(
        SessionRequestSchema.safeParse(raw),
        "session request",
        "Use the matching mako-control CLI and its session file; see mako-control --help."
      )
      method = input.operation.method
      if (
        input.build !== descriptor.build ||
        input.session !== descriptor.session
      )
        throw new ControlFault(
          "incompatible-session",
          "Session/build mismatch. Use the matching CLI and exact session file; no action was dispatched.",
          "not-dispatched"
        )
      controller.signal.throwIfAborted()
      outcome = "unknown"
      const value = z
        .json()
        .parse(await invoke(input.operation, controller.signal))
      outcome = "completed"
      if (method === "stop") response.once("finish", stop)
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, requestId, value }))
    })()
      .catch((error) => {
        const partial = error instanceof ControlProgramError ? error.output : undefined
        const cause = error instanceof ControlProgramError ? error.cause : error
        const detail = controlFaultData(cause)
        outcome = detail?.outcome ?? outcome
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: false,
            requestId,
            fault: {
              code:
                detail?.code ??
                (outcome === "not-dispatched"
                  ? "invalid-request"
                  : "session-error"),
              message:
                cause instanceof Error
                  ? cause.message
                  : "Local Control request failed",
              outcome,
            },
            output: partial?.length ? partial : undefined,
            ran: error instanceof ControlProgramError && error.effects.length ? error.effects.map(effectText) : undefined,
          })
        )
      })
      .finally(() => {
        requests.delete(controller)
        diagnostics.push({
          requestId,
          method,
          outcome,
          ms: Math.round((performance.now() - started) * 100) / 100,
        })
        if (diagnostics.length > 100) diagnostics.shift()
      })
  })
  async function close(): Promise<void> {
    return (closing ??= (async () => {
      stopped = true
      for (const request of requests) request.abort()
      server.closeAllConnections()
      const stoppedServer = new Promise<void>((resolve) =>
        server.close(() => resolve())
      )
      await session.close()
      await stoppedServer
    })())
  }
  return { server, close }
}
