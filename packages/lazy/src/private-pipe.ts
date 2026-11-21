import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { execFile } from "node:child_process"
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createConnection, Socket, type Server } from "node:net"
import { homedir } from "node:os"
import { Duplex } from "node:stream"
import { dirname, join, win32 } from "node:path"
import { fileURLToPath } from "node:url"
import { onWindows } from "./platform.js"
/**
 * Windows named pipes private to their user, kept in this package because every one of Mako's that listens on a pipe
 * already depends on it and it depends on nothing. For every server Mako runs on one: the host, the terminal daemon, the
 * sessions daemon and its catalog readers, the record of changes' owner. Pipes share one namespace across the machine;
 * any account can list the names in use and take one nobody is listening on. So no name is used for more than one
 * start of its server: it's drawn with a secret, listened on, then published in a file only its user can read, and
 * both ends of every connection prove they know the secret before anything else crosses it (`connectProven`,
 * `requireProof`). Locks that only need a name use an exclusively opened file in this user's folder instead.
 */

/**
 * A Windows named pipe's name and secret, drawn for one start of the server that listens on it and published in a
 * file of a folder only its user can read, once it listens. Windows' pipes share one namespace across the machine and
 * any account can list it, so a name is private only until its server listens: none is used for more than one start,
 * and both ends prove they know the secret before anything crosses a connection (`pipe-handshake.ts`).
 */
export interface KeptPipe {
  pipe: string
  proof: string
}

const PIPE_PREFIX = "\\\\.\\pipe\\"
const PIPE_NAME = /^\\\\\.\\pipe\\[a-z0-9-]+-[0-9a-f]{32}$/
const PROOF = /^[0-9a-f]{64}$/

/** A published pipe as its file holds it: exactly a pipe's name and its secret, nothing else. */
function parseKeptPipe(text: string): KeptPipe | undefined {
  const value: unknown = JSON.parse(text)
  if (value === null || !(value instanceof Object) || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  const field = (name: string) => entries.find(([key]) => key === name)?.[1]
  const pipe = String(field("pipe") ?? "")
  const proof = String(field("proof") ?? "")
  return entries.length === 2 && PIPE_NAME.test(pipe) && PROOF.test(proof) ? { pipe, proof } : undefined
}

/** A Windows named pipe's path, which Node's `net` and `http` take where they take a socket's. */
export const isPipePath = (path: string): boolean => path.startsWith(PIPE_PREFIX)

/** Mako's folder in the user's local app data, which only they, SYSTEM and administrators can read. */
export function makoLocalFolder(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Mako")
}

/** What `file` publishes, when it publishes a pipe named `<prefix>-<random>`. */
export function readKeptPipe(file: string, prefix: string): KeptPipe | undefined {
  try {
    const kept = parseKeptPipe(readFileSync(file, "utf8"))
    return kept?.pipe.startsWith(`${PIPE_PREFIX}${prefix}-`) ? kept : undefined
  } catch {
    return undefined
  }
}

/** A new name, `<prefix>-<128 random bits>`, and a 256-bit secret, for one start of a server. */
export function drawKeptPipe(prefix: string): KeptPipe {
  return { pipe: `${PIPE_PREFIX}${prefix}-${randomBytes(16).toString("hex")}`, proof: randomBytes(32).toString("hex") }
}

/** Publishes `pipe` in `file` in one rename, so a reader finds the whole of the old or the whole of the new. */
export function publishKeptPipe(file: string, pipe: KeptPipe): void {
  mkdirSync(dirname(file), { recursive: true })
  const draft = join(dirname(file), `.pipe-${process.pid}-${randomBytes(4).toString("hex")}`)
  writeFileSync(draft, JSON.stringify(pipe), { flag: "wx", mode: 0o600 })
  try {
    renameSync(draft, file)
  } catch (error) {
    rmSync(draft, { force: true })
    throw error
  }
}

/** Removes what `file` publishes, when it is still `pipe`: a later start's is left alone. */
export function retractKeptPipe(file: string, prefix: string, pipe: KeptPipe): void {
  if (readKeptPipe(file, prefix)?.pipe === pipe.pipe) rmSync(file, { force: true })
}


/**
 * Both ends of a Windows pipe proving, on the connection itself and before anything else crosses it, that each knows
 * the secret drawn with the pipe's name for this start of its server (`kept-pipe.ts`). A program that took the name
 * learns nothing and is told nothing: the client sends only a random challenge until the server has answered it.
 *
 *     client → server   MAKO-PIPE 1 <client nonce>\n
 *     server → client   HMAC(secret, "server:" + client nonce) <server nonce>\n
 *     client → server   HMAC(secret, "client:" + server nonce)\n
 *     server → client   ok\n
 *
 * Then the connection is the protocol's (HTTP for the host, JSON lines for the terminal daemon), each side having
 * read exactly the handshake's lines. A server drops a connection that hasn't finished within `HANDSHAKE_MS`.
 */
const GREETING = "MAKO-PIPE 1"
const HANDSHAKE_MS = 5_000
const LINE_BYTES = 256

const mac = (secret: string, who: "server" | "client", nonce: string) => createHmac("sha256", secret).update(`${who}:${nonce}`).digest("hex")

function same(expected: string, said: string): boolean {
  return said.length === expected.length && timingSafeEqual(Buffer.from(said), Buffer.from(expected))
}

/** Something on the pipe couldn't prove it is the server its name was drawn for. */
export class PipeImpostorError extends Error {
  readonly code = "EMAKOIMPOSTOR"
}

/** Reads lines off `socket` until `step` says it's done, within the handshake's time; nothing past them is read. */
function lines(socket: Socket, step: (line: string) => boolean, done: (error?: Error) => void): void {
  let buffered = ""
  const timer = setTimeout(() => finish(new PipeImpostorError("The pipe's handshake took too long")), HANDSHAKE_MS)
  const finish = (error?: Error) => {
    clearTimeout(timer)
    socket.off("data", data)
    socket.off("error", finish)
    socket.off("close", closed)
    done(error)
  }
  const closed = () => finish(new PipeImpostorError("The pipe closed during its handshake"))
  const data = (chunk: Buffer) => {
    buffered += chunk.toString("latin1")
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      let more: boolean
      try {
        more = step(line)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (!more) {
        // The other side sends nothing more until this one answers: nothing can be buffered past the last line.
        if (buffered) finish(new PipeImpostorError("The pipe's handshake was followed by more than it allows"))
        else finish()
        return
      }
    }
    if (buffered.length > LINE_BYTES) finish(new PipeImpostorError("The pipe's handshake line is too long"))
  }
  socket.on("data", data)
  socket.on("error", finish)
  socket.on("close", closed)
}

/**
 * A connection to `path` once its server has proved it knows `secret` and this side has too; until then nothing but
 * a nonce is written. Fails with `PipeImpostorError` when the server can't prove it.
 */
export function connectProven(path: string, secret: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const nonce = randomBytes(16).toString("hex")
    let stage: "server" | "ok" = "server"
    let connected = false
    socket.once("connect", () => {
      connected = true
      lines(socket, (line) => {
        if (stage === "server") {
          const [proof = "", serverNonce = ""] = line.split(" ")
          if (!same(mac(secret, "server", nonce), proof) || !/^[0-9a-f]{32}$/.test(serverNonce))
            throw new PipeImpostorError(`Something other than the server this pipe was drawn for answers on ${path}`)
          socket.write(`${mac(secret, "client", serverNonce)}\n`)
          stage = "ok"
          return true
        }
        if (line !== "ok") throw new PipeImpostorError(`The server on ${path} refused this client's proof`)
        return false
      }, (error) => {
        if (error) {
          socket.destroy()
          reject(error)
        } else resolve(socket)
      })
      socket.write(`${GREETING} ${nonce}\n`)
    })
    // Failing to connect at all (no such pipe) is the caller's to hear; a failure after is the handshake's.
    socket.once("error", (error) => {
      if (!connected) reject(error)
    })
  })
}

/** Servers whose connections already prove themselves (`requireProof`). */
const proving = new WeakSet<Server>()

/**
 * Makes every connection `server` accepts prove itself first: its `connection` listeners (HTTP's, or a protocol's),
 * whenever they were or are added, hear a socket only once the client has proved it knows `secret()`; one that doesn't
 * is closed having been told nothing but this server's proof of the nonce it sent.
 */
export function requireProof(server: Server, secret: () => string | undefined): void {
  // Once a server: a second handshake over the first would ask every client to prove itself twice.
  if (proving.has(server)) throw new Error("This server's connections already prove themselves")
  proving.add(server)
  // The server's own `emit` is what announces a connection: taken over, so no listener's order matters.
  const emit = server.emit.bind(server)
  const proven = (socket: Socket) => emit("connection", socket)
  const accept = (socket: Socket) => {
    const known = secret()
    // No secret, no way to prove: nothing is served unproven.
    if (!known) {
      socket.destroy()
      return
    }
    const nonce = randomBytes(16).toString("hex")
    let stage: "greeting" | "client" = "greeting"
    // A server that takes its connections paused (`pauseOnConnect`) gets them back paused, the handshake read between.
    const paused = socket.readableFlowing === false
    if (paused) socket.resume()
    lines(socket, (line) => {
      if (stage === "greeting") {
        const [greeting = "", version = "", clientNonce = ""] = line.split(" ")
        if (`${greeting} ${version}` !== GREETING || !/^[0-9a-f]{32}$/.test(clientNonce)) throw new PipeImpostorError("A client skipped the pipe's handshake")
        socket.write(`${mac(known, "server", clientNonce)} ${nonce}\n`)
        stage = "client"
        return true
      }
      if (!same(mac(known, "client", nonce), line)) throw new PipeImpostorError("A client couldn't prove it may use this pipe")
      return false
    }, (error) => {
      if (error) {
        socket.destroy()
        return
      }
      if (paused) socket.pause()
      socket.write("ok\n")
      // Handed over in this same turn, so nothing the client sends next arrives with no listener to hear it.
      proven(socket)
    })
  }
  // SAFETY: `emit` keeps Node's own signature; only a `connection` and its socket are read before passing on.
  server.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event !== "connection") return emit(event, ...args)
    const [socket] = args
    if (socket instanceof Socket) accept(socket)
    // Anything else announced as a connection is served by nobody.
    else if (socket instanceof Duplex) socket.destroy()
    return true
  }) as typeof server.emit
}


/**
 * Where a server that listens on a fresh pipe each start publishes it, by its family's name (`mako-syncd`,
 * `mako-catalog-<identity>`): `%LOCALAPPDATA%\Mako\pipes\<family>.json`. Clients name the family, a pipe nobody ever
 * listens on, and reach the one published now (`connectFamily`).
 */
export function familyFile(family: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(makoLocalFolder(env), "pipes", `${familyName(family)}.json`)
}

/** `\\.\pipe\mako-syncd` as `mako-syncd`. */
function familyName(family: string): string {
  const name = family.slice(PIPE_PREFIX.length)
  if (!isPipePath(family) || !/^[a-z0-9-]{1,120}$/.test(name)) throw new Error(`Not a pipe family: ${family}`)
  return name
}

/** Whether `path` names a family of pipes rather than one pipe: a pipe path without a drawn name's random suffix. */
export const isPipeFamily = (path: string): boolean => isPipePath(path) && /^[a-z0-9-]{1,120}$/.test(path.slice(PIPE_PREFIX.length)) && !/-[0-9a-f]{32}$/.test(path)

/** A pipe and secret drawn for this start of the family's server, to listen on and then publish. */
export function drawFamilyPipe(family: string): KeptPipe {
  return drawKeptPipe(familyName(family))
}

export function publishFamilyPipe(family: string, pipe: KeptPipe, env: NodeJS.ProcessEnv = process.env): void {
  publishKeptPipe(familyFile(family, env), pipe)
}

export function retractFamilyPipe(family: string, pipe: KeptPipe, env: NodeJS.ProcessEnv = process.env): void {
  retractKeptPipe(familyFile(family, env), familyName(family), pipe)
}

/** What the family's server published now, if it has. */
export function publishedFamilyPipe(family: string, env: NodeJS.ProcessEnv = process.env): KeptPipe | undefined {
  return readKeptPipe(familyFile(family, env), familyName(family))
}

/** A proven connection to the pipe the family's server published now; ENOENT when there is none. */
export function connectFamily(family: string, env: NodeJS.ProcessEnv = process.env): Promise<Socket> {
  const kept = publishedFamilyPipe(family, env)
  if (!kept) return Promise.reject(Object.assign(new Error(`No server has published ${family}`), { code: "ENOENT" }))
  return connectProven(kept.pipe, kept.proof)
}

/** A lock held by an open file no other process can open meanwhile, released when it closes or its process ends. */
export interface FileLock {
  release(): void
}

/**
 * Windows' lock: `path` opened with no sharing at all (libuv's `UV_FS_O_EXLOCK`), which the system lets go of with
 * its process however that ends. Kept in a folder of this user's, it can't be taken or held by another account, as a
 * pipe's name could. Null while another holds it.
 */
export function exclusiveFileLock(path: string): FileLock | null {
  mkdirSync(dirname(path), { recursive: true })
  let fd: number
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | WINDOWS_EXLOCK, 0o600)
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES")) return null
    throw error
  }
  let released = false
  return {
    release() {
      if (released) return
      released = true
      closeSync(fd)
    },
  }
}

/** Whether another process holds `path`'s lock now, without taking it; a lock file that isn't there is free. */
export function exclusiveFileLockHeld(path: string): boolean {
  try {
    closeSync(openSync(path, constants.O_RDWR | WINDOWS_EXLOCK))
    return false
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined
    if (code === "ENOENT") return false
    return code === "EBUSY" || code === "EPERM" || code === "EACCES"
  }
}

/** libuv's flag for a file opened with no sharing (`UV_FS_O_EXLOCK`), Windows only; 0 elsewhere, where these locks aren't used. */
// SAFETY: Node defines `UV_FS_O_EXLOCK` among `fs.constants` on Windows; its typings leave it out.
const WINDOWS_EXLOCK = onWindows() ? ((constants as typeof constants & { UV_FS_O_EXLOCK?: number }).UV_FS_O_EXLOCK ?? 0x10000000) : 0

/**
 * `mako-windows.exe`, the helper that narrows a pipe's DACL (`native/windows-helper`), by its whole path: where
 * `MAKO_WINDOWS_HELPER` says, beside the app's executable (`MAKO_HOST_EXECUTABLE`), or a checkout's build.
 */
export function windowsHelperPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [
    env.MAKO_WINDOWS_HELPER,
    env.MAKO_HOST_EXECUTABLE ? join(dirname(env.MAKO_HOST_EXECUTABLE), "mako-windows.exe") : undefined,
    fileURLToPath(new URL("../../../build/mako-windows.exe", import.meta.url)),
  ]
  return candidates.find((path): path is string => path !== undefined && win32.isAbsolute(path) && existsSync(path))
}

/**
 * Narrows listening pipes' DACLs to their owner's alone, network logons denied (`mako-windows secure-pipe`), in the
 * background; whether every one was. Hardening, not the guarantee, which is the handshake: a pipe is open to read for
 * a moment before this runs, and where the helper is missing it never does.
 */
export function restrictPipes(pipes: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const helper = windowsHelperPath(env)
  if (!helper) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile(helper, ["secure-pipe", ...pipes], { encoding: "utf8", timeout: 15_000, windowsHide: true }, (error, stdout) => {
      const said = stdout.trim().split(/\r?\n/)
      resolve(!error && said.length === pipes.length && said.every((line) => line === "secured"))
    })
  })
}
