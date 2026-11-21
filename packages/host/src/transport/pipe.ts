import { createHash } from "node:crypto"
import type { ClientRequestArgs } from "node:http"
import { join, resolve } from "node:path"
import { drawKeptPipe, makoLocalFolder, publishKeptPipe, readKeptPipe, retractKeptPipe, type KeptPipe } from "../base/kept-pipe.js"
import { connectProven } from "../base/pipe-handshake.js"

/**
 * Where a host listens on Windows, which has no Unix sockets in Node: a named pipe. Pipes share one namespace across
 * the machine; any account can list the names in it, and take one nobody is listening on. Node creates each pipe with
 * the system's default DACL (Windows CI read it as `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<owner>)(A;;FR;;;WD)(A;;FR;;;AN)`)
 * and can't set its own or refuse remote clients; the host narrows it once it listens (`base/pipe-restriction.ts`).
 * None of that is what keeps the host's clients safe. What does:
 *
 * - Each start of a host draws a new name, 128 random bits, and a secret, 256 bits, listens on the name, and only then
 *   publishes both in `pipe.json`, in the user's own local app data (`%LOCALAPPDATA%\Mako\host-<id>`, a folder made
 *   theirs alone). A name seen listed while a host ran is never a host's again.
 * - Every connection proves itself both ways before a byte of HTTP crosses it (`base/pipe-handshake.ts`): the client
 *   sends a nonce, the host answers with an HMAC of it under the secret, and the client answers the host's nonce the
 *   same way. A program holding a name it saw listed gets a nonce and nothing else: no call, no data key, no event.
 * - A client reaches only the name `pipe.json` names now, and finds any other profile pipe absent.
 *
 * Elsewhere none of this applies: the socket is a file in a folder only its user can open.
 */
const HOST_PIPE = /^\\\\\.\\pipe\\mako-host-([0-9a-f]{16})-[0-9a-f]{32}$/

export { isPipePath } from "../base/kept-pipe.js"

/** The profile a data root is, as its host's folder and pipe are named. */
export function runtimeIdentity(dataRoot: string): string {
  return createHash("sha256").update(resolve(dataRoot)).digest("hex").slice(0, 16)
}

/** The folder private to the user that holds a host's pipe name: in their local app data, beside nothing shared. */
export function windowsRuntimeDirectory(identity: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(makoLocalFolder(env), `host-${identity}`)
}

const pipeFile = (directory: string) => join(directory, "pipe.json")
const prefix = (identity: string) => `mako-host-${identity}`

/** A name and secret for this start of the host for profile `identity`, drawn now and published once it listens. */
export function drawHostPipe(identity: string): KeptPipe {
  return drawKeptPipe(prefix(identity))
}

/** Says where this start of the host listens, in one rename, for every client that looks from now on. */
export function publishHostPipe(directory: string, pipe: KeptPipe): void {
  publishKeptPipe(pipeFile(directory), pipe)
}

/** Takes back what `publishHostPipe` said, when it still names `pipe`: the host is leaving. */
export function retractHostPipe(directory: string, identity: string, pipe: KeptPipe): void {
  retractKeptPipe(pipeFile(directory), prefix(identity), pipe)
}

/**
 * The pipe the host for profile `identity` published, or one no host listens on: a client asking before any host has
 * published reaches nothing (`hostPipeSecret` refuses it).
 */
export function publishedHostPipe(directory: string, identity: string): string {
  return readKeptPipe(pipeFile(directory), prefix(identity))?.pipe ?? `\\\\.\\pipe\\${prefix(identity)}-${"0".repeat(32)}`
}

/**
 * The secret of the host on `socket`, when `socket` is a profile's pipe: `null` when it isn't the one now published
 * (an older start's, or none), which no client reaches; undefined for any other socket (a Unix socket, a test's own
 * pipe), whose privacy doesn't rest on it.
 */
export function hostPipeSecret(socket: string, env: NodeJS.ProcessEnv = process.env): string | null | undefined {
  const identity = HOST_PIPE.exec(socket)?.[1]
  if (!identity) return undefined
  const kept = readKeptPipe(pipeFile(windowsRuntimeDirectory(identity, env)), prefix(identity))
  return kept?.pipe === socket ? kept.proof : null
}

/** How a client starts a connection to the host: `http.request`'s `createConnection`. */
export type RuntimeConnect = NonNullable<ClientRequestArgs["createConnection"]>

/**
 * Where `http.request` reaches the host: a socket's path, or a connection it makes. With a connection of its own the
 * request has no agent: Node's agents (`agent: false` makes one) open sockets themselves and pass this one by.
 */
export type RuntimeConnection = { socketPath: string } | { createConnection: RuntimeConnect; agent: undefined }

/**
 * What `http.request` needs to reach the host on `socket`: its path, for a Unix socket or another pipe; for a
 * profile's pipe, a connection that has proved both ends first (`connectProven`), or none at all when the pipe isn't
 * the one published now.
 */
export function runtimeConnection(socket: string): RuntimeConnection {
  const secret = hostPipeSecret(socket)
  if (secret === undefined) return { socketPath: socket }
  return {
    agent: undefined,
    createConnection: (_options, made) => {
      // SAFETY: `made` reports a failure without a socket, as Node's own connection does; the type asks for one.
      const failed = (error: Error) => made(error, undefined as never)
      if (secret === null) process.nextTick(() => failed(Object.assign(new Error(`No Mako host has published ${socket}`), { code: "ENOENT" })))
      else connectProven(socket, secret).then((connection) => made(null, connection), failed)
      return undefined
    },
  }
}
