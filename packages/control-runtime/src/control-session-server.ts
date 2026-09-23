import { createServer } from "node:http"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import {
  controlClient,
  controlFaultData,
  ControlFault,
  controlInput,
  RecordingReceiptSchema,
} from "@mako/control/control"
import { spillImage } from "@mako/control/program"
import type { ControlSession } from "./control-session.js"
import {
  CONTROL_SESSION_PROTOCOL,
  controlSessionBuild,
  SessionRequestSchema,
  type SessionDescriptor,
  type SessionOperation,
} from "./control-session-protocol.js"

const engineBuild = controlSessionBuild()
// Preserve a load-time identity without making a missing optional CLI payload
// crash MCP-only callers. Starting the CLI transport still reports this failure.
void engineBuild.catch(() => {})

/** The socket borrows one engine. Closing a request never closes its session. */
export async function serveControlSession(
  session: ControlSession,
  options: { onStop?: () => void } = {}
) {
  const build = await engineBuild
  const directory = await mkdtemp(join(tmpdir(), "mako-control-"))
  await chmod(directory, 0o700)
  const socket = join(directory, "session.sock")
  const file = join(directory, "session.json")
  const descriptor: SessionDescriptor = {
    protocol: CONTROL_SESSION_PROTOCOL,
    build,
    session: randomUUID(),
    socket,
    pid: process.pid,
  }
  const requests = new Set<AbortController>()
  const diagnostics: Array<{
    requestId: string
    method: string
    outcome: string
    ms: number
  }> = []
  let closing: Promise<void> | undefined
  let stopped = false
  async function invoke(operation: SessionOperation, signal: AbortSignal) {
    switch (operation.method) {
      case "status":
        return session.status()
      case "help":
        return session.help(operation.args)
      case "diagnostics":
        return { ...session.diagnostics(), requests: [...diagnostics] }
      case "exec": {
        const blocks = await session.execute(
          { source: operation.source },
          signal,
          { yield: false }
        )
        const output = []
        for (const block of blocks) {
          if (block.type !== "image") {
            output.push(block)
            continue
          }
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
        }
        return output
      }
      case "call":
        return session.call(operation.command, signal)
      case "shot": {
        const client = controlClient((action, args) =>
          session.call({ action, ...args }, signal)
        )
        const handle =
          operation.target.kind === "page"
            ? client.tab(operation.target)
            : client.window(operation.target)
        return operation.selector
          ? handle.locator(operation.selector).screenshot(operation.options)
          : handle.screenshot(operation.options)
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
        if (bytes > 512 * 1024)
          throw new ControlFault(
            "input-limit",
            "Request exceeds 512 KiB.",
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
      if (method === "stop")
        response.once("finish", () => {
          void close().then(() => options.onStop?.())
        })
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, requestId, value }))
    })()
      .catch((error) => {
        const detail = controlFaultData(error)
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
                error instanceof Error
                  ? error.message
                  : "Local Control request failed",
              outcome,
            },
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
      try {
        await session.close()
        await stoppedServer
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })())
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socket, resolve)
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
