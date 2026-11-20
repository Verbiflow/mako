import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { createConnection, type Server, type Socket } from "node:net"

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

/**
 * Makes every connection `server` accepts prove itself first: its own `connection` listeners (HTTP's, or a
 * protocol's) hear a socket only once the client has proved it knows `secret()`; one that doesn't is closed having
 * been told nothing but this server's proof of the nonce it sent. Call it before `listen`.
 */
export function requireProof(server: Server, secret: () => string | undefined): void {
  const listeners = server.listeners("connection")
  server.removeAllListeners("connection")
  server.on("connection", (socket: Socket) => {
    const known = secret()
    if (!known) {
      for (const listener of listeners) listener.call(server, socket)
      return
    }
    const nonce = randomBytes(16).toString("hex")
    let stage: "greeting" | "client" = "greeting"
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
      socket.write("ok\n")
      // Handed over in this same turn, so nothing the client sends next arrives with no listener to hear it.
      for (const listener of listeners) listener.call(server, socket)
    })
  })
}
