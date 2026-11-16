import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { request } from "node:http"
import { dirname, isAbsolute } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { ControlFault } from "@mako/control/control"
import { ControlStepsSchema, type ControlSteps } from "@mako/control/program"
import {
  controlSessionBuild,
  SessionDescriptorSchema,
  SessionReplySchema,
  type SessionDescriptor,
  type SessionOperation,
} from "./control-session-protocol.js"

async function assertPrivate(path: string, kind: "directory" | "socket") {
  const info = await lstat(path)
  if (
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    (kind === "directory" ? !info.isDirectory() : !info.isSocket())
  )
    throw new ControlFault(
      "invalid-session",
      "Session socket and directory must belong only to the current user.",
      "not-dispatched"
    )
}
export async function readControlSession(
  file: string
): Promise<SessionDescriptor> {
  try {
    return await readDescriptor(file)
  } catch (error) {
    if (error instanceof ControlFault) throw error
    throw new ControlFault(
      "invalid-session",
      "Could not read this private session or its socket. Use the sessionFile from the live owner; no new session was started.",
      "not-dispatched"
    )
  }
}
async function readDescriptor(file: string): Promise<SessionDescriptor> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      info.size > 8192 ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      throw new ControlFault(
        "invalid-session",
        "Use the private session file created by the engine (owner-only permissions).",
        "not-dispatched"
      )
    const descriptor = SessionDescriptorSchema.parse(
      JSON.parse(await handle.readFile("utf8"))
    )
    if (!isAbsolute(descriptor.socket))
      throw new ControlFault(
        "invalid-session",
        "Session socket path must be absolute.",
        "not-dispatched"
      )
    await assertPrivate(dirname(descriptor.socket), "directory")
    await assertPrivate(descriptor.socket, "socket")
    if (descriptor.build !== (await controlSessionBuild()))
      throw new ControlFault(
        "incompatible-session",
        "CLI and running engine builds differ. Use the matching task CLI. If that build is no longer available, end the task through its owner and start a new task; no command was dispatched.",
        "not-dispatched"
      )
    return descriptor
  } finally {
    await handle.close()
  }
}

/** A step frame of an NDJSON reply (`SessionRequest.steps`); the reply's own line has a `requestId` instead. */
const StepFrameSchema = z.object({ steps: ControlStepsSchema }).strict()

/**
 * Splits an NDJSON reply as it arrives: each step frame goes to `steps` at
 * once, and the rest, the reply's own line, is kept for the end.
 */
function stepFrames(steps: (steps: ControlSteps) => void) {
  let partial = ""
  let rest = ""
  const line = (text: string) => {
    if (!text.trim()) return
    const frame = text.startsWith('{"steps":') ? StepFrameSchema.safeParse(JSON.parse(text)) : undefined
    if (frame?.success) steps(frame.data.steps)
    else rest += text
  }
  return {
    take(chunk: Buffer): void {
      const lines = (partial + chunk.toString("utf8")).split("\n")
      partial = lines.pop() ?? ""
      for (const text of lines) line(text)
    },
    reply(): string {
      line(partial)
      partial = ""
      return rest
    },
  }
}

export async function requestControlSession(
  descriptor: SessionDescriptor,
  operation: SessionOperation,
  signal: AbortSignal,
  /** Asks for a js call's steps as they change (`SessionRequest.steps`). */
  steps?: (steps: ControlSteps) => void
) {
  if (signal.aborted)
    throw new ControlFault(
      "cancelled",
      "Command cancelled before dispatch.",
      "not-dispatched"
    )
  const requestId = randomUUID()
  let submitted = false
  try {
    return await new Promise<ReturnType<typeof SessionReplySchema.parse>>(
      (resolve, reject) => {
        const call = request(
          {
            socketPath: descriptor.socket,
            path: "/request",
            method: "POST",
            agent: false,
            headers: { "content-type": "application/json" },
            signal,
          },
          (response) => {
            const chunks: Buffer[] = []
            const frames = steps ? stepFrames(steps) : undefined
            let bytes = 0
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length
              if (bytes > 32 * 1024 * 1024) {
                response.destroy(new Error("Session reply exceeds 32 MiB"))
                return
              }
              if (frames) frames.take(chunk)
              else chunks.push(chunk)
            })
            response.once("error", reject)
            response.once("end", () => {
              try {
                const reply = SessionReplySchema.parse(
                  JSON.parse(frames ? frames.reply() : Buffer.concat(chunks).toString("utf8"))
                )
                if (reply.requestId !== requestId)
                  throw new Error("Session reply identity mismatch")
                resolve(reply)
              } catch (error) {
                reject(error)
              }
            })
          }
        )
        call.once("error", reject)
        call.once("finish", () => {
          submitted = true
        })
        call.end(
          JSON.stringify({
            ...descriptor,
            pid: undefined,
            socket: undefined,
            requestId,
            operation,
            ...steps && { steps: true },
          })
        )
      }
    )
  } catch {
    throw new ControlFault(
      signal.aborted ? "cancelled" : "session-connection-failed",
      submitted
        ? "Connection ended after the request may have been dispatched. Do not replay it; inspect the same session and target."
        : "Could not reach this exact session. No replacement session was started.",
      submitted ? "unknown" : "not-dispatched"
    )
  }
}

/** Typed callers consume engine values; transport receipts stay at this boundary. */
export async function invokeControlSession(
  descriptor: SessionDescriptor,
  operation: SessionOperation,
  signal: AbortSignal,
  steps?: (steps: ControlSteps) => void
) {
  const reply = await requestControlSession(descriptor, operation, signal, steps)
  if (!reply.ok) throw new ControlFault(reply.fault.code, reply.fault.message, reply.fault.outcome)
  return reply.value
}
