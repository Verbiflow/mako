import { randomUUID } from "node:crypto"
import { connect, type Socket } from "node:net"
import { problem, SSH_CHUNK_BYTES, SshOutgoing, type MediaStreamId, type Problem, type SshHandler, type SshSender } from "@mako/protocol"
import { hostLog, hostWarn } from "../base/host-log.js"

type Relayed = {
  socket: Socket
  outgoing: SshOutgoing
  sender: SshSender
  correlationId: string
  threadId: string
  started: number
  up: number
  down: number
  opened: boolean
  ended: boolean
}

/**
 * SSH from the person's editor to this machine (`ssh.ts` in `@mako/protocol`): each stream the gateway opens becomes
 * a connection to the machine's own SSH server on the loopback, the only thing it ever reaches, with the server's
 * bytes going back paced by what the client took and the client's written as the server takes them. A host with no
 * SSH server (a Mac's, or a machine whose agent named none) ends every stream at once.
 */
export class SshRelay implements SshHandler {
  readonly #port: () => number | undefined
  readonly #relayed = new Map<MediaStreamId, Relayed>()

  /** `port`: where the machine's SSH server listens on the loopback now, as its agent said; undefined while it says none. */
  constructor(options: { port: () => number | undefined }) {
    this.#port = options.port
  }

  open(stream: MediaStreamId, threadId: string, sender: SshSender): void {
    this.closed(stream)
    const correlationId = randomUUID()
    const port = this.#port()
    if (port === undefined) {
      hostWarn("gateway", "an SSH stream was refused: this machine serves no SSH", { stream, threadId, correlationId })
      return sender.end(problem("unavailable", "This machine serves no SSH", correlationId, "not-applied", { status: 503 }))
    }
    const socket = connect({ host: "127.0.0.1", port })
    const relayed: Relayed = {
      socket,
      outgoing: new SshOutgoing((piece) => sender.send(piece)),
      sender,
      correlationId,
      threadId,
      started: performance.now(),
      up: 0,
      down: 0,
      opened: false,
      ended: false,
    }
    this.#relayed.set(stream, relayed)
    socket.setNoDelay(true)
    socket.once("connect", () => {
      relayed.opened = true
      hostLog("gateway", "an SSH stream opened", { stream, threadId, correlationId, ms: Math.round(performance.now() - relayed.started) })
      sender.opened()
      relayed.outgoing.release()
    })
    socket.on("data", (chunk: Buffer) => {
      relayed.down += chunk.byteLength
      relayed.outgoing.write(chunk)
      // The client takes the server's bytes at its own pace: the server is read no faster.
      if (relayed.outgoing.queued < SSH_CHUNK_BYTES) return
      socket.pause()
      void relayed.outgoing.drained().then(() => socket.resume())
    })
    socket.once("error", (error: NodeJS.ErrnoException) => {
      hostWarn("gateway", "an SSH stream's connection to the server failed", { stream, threadId, correlationId, opened: relayed.opened, error: error.message, code: error.code ?? null })
      const reason = relayed.opened
        ? problem("unavailable", "The machine's SSH server's connection failed", correlationId, "unknown", { status: 503, detail: error.message })
        : problem("unavailable", "The machine's SSH server isn't running", correlationId, "not-applied", { status: 503, detail: error.message })
      this.#end(stream, relayed, reason)
    })
    // What the server said last still reaches the client before it hears the end.
    socket.once("close", () => void relayed.outgoing.drained().then(() => this.#end(stream, relayed, undefined)))
  }

  data(stream: MediaStreamId, data: Uint8Array): void {
    const relayed = this.#relayed.get(stream)
    if (!relayed || relayed.ended) return
    relayed.up += data.byteLength
    relayed.socket.write(data, (error) => {
      if (!error) relayed.sender.took(data.byteLength)
    })
  }

  acked(stream: MediaStreamId, received: number): void {
    this.#relayed.get(stream)?.outgoing.acked(received)
  }

  closed(stream: MediaStreamId): void {
    const relayed = this.#relayed.get(stream)
    if (!relayed) return
    this.#relayed.delete(stream)
    relayed.ended = true
    relayed.outgoing.close()
    relayed.socket.destroy()
    this.#logEnd(stream, relayed, "the client left")
  }

  #end(stream: MediaStreamId, relayed: Relayed, reason: Problem | undefined): void {
    if (relayed.ended) return
    relayed.ended = true
    if (this.#relayed.get(stream) === relayed) this.#relayed.delete(stream)
    relayed.outgoing.close()
    relayed.socket.destroy()
    relayed.sender.end(reason)
    this.#logEnd(stream, relayed, reason ? reason.title : "the server closed it")
  }

  #logEnd(stream: MediaStreamId, relayed: Relayed, why: string): void {
    hostLog("gateway", "an SSH stream ended", { stream, threadId: relayed.threadId, correlationId: relayed.correlationId, why, up: relayed.up, down: relayed.down, ms: Math.round(performance.now() - relayed.started) })
  }
}
