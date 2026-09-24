import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { request } from "node:http"
import { dirname, isAbsolute } from "node:path"
import { randomUUID } from "node:crypto"
import { ControlFault } from "@mako/control/control"
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

export async function requestControlSession(
  descriptor: SessionDescriptor,
  operation: SessionOperation,
  signal: AbortSignal
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
            let bytes = 0
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length
              if (bytes > 32 * 1024 * 1024) {
                response.destroy(new Error("Session reply exceeds 32 MiB"))
                return
              }
              chunks.push(chunk)
            })
            response.once("error", reject)
            response.once("end", () => {
              try {
                const reply = SessionReplySchema.parse(
                  JSON.parse(Buffer.concat(chunks).toString("utf8"))
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
