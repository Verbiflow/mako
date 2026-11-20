import { timingSafeEqual } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { keptPipe, readKeptPipe, redrawPipe } from "../base/kept-pipe.js"

/**
 * Where a host listens on Windows, which has no Unix sockets in Node: a named pipe. Pipes live in one namespace the
 * whole machine shares, and Node creates each with the system's default DACL (Windows CI read it as
 * `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<owner>)(A;;FR;;;WD)(A;;FR;;;AN)`): its owner, SYSTEM and administrators may do
 * anything, every other account may open it to read and nothing else. Reading a connection of one's own gets nothing
 * from the host, which writes only answers to requests, and no other account can write a request or add an instance of
 * the pipe (`scripts/windows-host/pipe-access.ps1` holds both). What another account can do is take the name first,
 * when no host holds it, and answer as if it were one. So:
 *
 * - The name is random, 128 bits, drawn once per profile and kept with a proof in `pipe.json`, in the user's own local
 *   app data (`%LOCALAPPDATA%\Mako\host-<id>`, which only the user, SYSTEM and administrators can read), never in a
 *   shared temp folder: no other account can know it before a host has listened on it.
 * - The host says the proof in every `/health` answer (`HOST_PROOF_HEADER`), which only an account that can write to
 *   the pipe can ask for, and a client probing the host by that name believes nothing that doesn't say it
 *   (`HostImpostorError`). A launcher that meets one draws a new name and starts its host there.
 *
 * Elsewhere none of this applies: the socket is a file in a folder only its user can open.
 */
export const HOST_PROOF_HEADER = "x-mako-host-proof"

const HOST_PIPE = /^\\\\\.\\pipe\\mako-host-([0-9a-f]{16})-[0-9a-f]{32}$/

export { isPipePath } from "../base/kept-pipe.js"

/** The folder private to the user that holds a host's pipe name: in their local app data, beside nothing shared. */
export function windowsRuntimeDirectory(identity: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Mako", `host-${identity}`)
}

/** The host's pipe for the profile `identity` names, whose folder is `directory`: the one kept there, or one drawn now. */
export function hostPipe(directory: string, identity: string): string {
  return keptPipe(join(directory, "pipe.json"), `mako-host-${identity}`).pipe
}

/** Something other than this profile's host answered on its pipe: a new name, so the next host listens where it can't be. */
export function redrawHostPipe(directory: string, identity: string): string {
  return redrawPipe(join(directory, "pipe.json"), `mako-host-${identity}`).pipe
}

/**
 * The proof a host on `socket` says, when `socket` is a profile's pipe: read from the folder the name was kept in.
 * `null` for a profile's pipe that is no longer its name (drawn again since), which no client should reach; undefined
 * for any other socket (a Unix socket, a test's own pipe), whose privacy doesn't rest on it.
 */
export function hostPipeProof(socket: string, env: NodeJS.ProcessEnv = process.env): string | null | undefined {
  const identity = HOST_PIPE.exec(socket)?.[1]
  if (!identity) return undefined
  const kept = readKeptPipe(join(windowsRuntimeDirectory(identity, env), "pipe.json"), `mako-host-${identity}`)
  return kept?.pipe === socket ? kept.proof : null
}

/** Whether `said`, a `/health` answer's proof header, is `expected`. */
export function proofHolds(expected: string, said: string | string[] | undefined): boolean {
  if (said === undefined || Array.isArray(said) || said.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(said), Buffer.from(expected))
}

/** Something answered on a profile's pipe without its host's proof: another program holds the name. */
export class HostImpostorError extends Error {
  readonly socket: string

  constructor(socket: string) {
    super(`Something other than Mako's host answers on ${socket}: another program holds the pipe's name`)
    this.socket = socket
  }
}
