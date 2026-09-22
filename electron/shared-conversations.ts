import { randomUUID } from "node:crypto"
import { lstat, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { z } from "zod"
import type { SessionMemory, ConversationRoute, ConversationEndpoint } from "./session-memory.js"
import { ensureRuntime, runtimeLocation } from "./runtime-service.js"
import { invokeRuntime, probeRuntime, subscribeRuntime, RuntimeDisconnectedError } from "./runtime-connection.js"

const snapshotIdentity = z.object({
  session: z.object({ id: z.string(), harness: z.string(), nativeId: z.string().optional() }),
  control: z.object({
    activeBindingId: z.string(),
    bindings: z.array(z.object({ id: z.string(), provider: z.string(), nativeId: z.string().optional() })),
  }).optional(),
})
const shutdownRequest = z.object({ type: z.literal("app-shutdown"), requestId: z.string() })
const batchIdentity = z.object({ type: z.literal("live-batch"), batch: z.object({ id: z.string() }) })
const liveTarget = z.object({ kind: z.literal("live"), id: z.string() })

// Only conversation operations cross hosts. Workspace state, app lifecycle,
// provider discovery and new conversations stay on the receiving host.
const conversationCalls = new Set([
  "mako:live-snapshot", "mako:live-state", "mako:live-prompt", "mako:live-permission",
  "mako:live-mode", "mako:live-cancel", "mako:live-close", "mako:live-edit-queued",
  "mako:live-clear-queue", "mako:live-earlier", "mako:live-bind", "mako:read-live-file",
  "mako:live-delegate", "mako:live-child-cancel", "mako:live-merge-fork",
  "mako:live-rewind-preview", "mako:live-rewind", "mako:live-action",
  "mako:live-action-acknowledge", "mako:live-fork", "mako:live-transfer",
])

type WireValue = z.infer<ReturnType<typeof z.json>>
export type ConversationRoutingResult = { handled: false } | { handled: true; value: WireValue | undefined }
interface Peer {
  ids: Set<string>
  stop?: () => void
  retry?: ReturnType<typeof setTimeout>
  handshake?: ReturnType<typeof setTimeout>
  ready: Promise<void>
  resolveReady(): void
  disconnected: boolean
  connecting: boolean
  observerSupported: boolean
  generation: number
  retryDelayMs: number
}

/** A second UI controls the original journal and driver through their host. */
export class SharedConversations {
  private readonly client = randomUUID()
  private readonly peers = new Map<string, Peer>()
  private closed = false
  private readonly waking = new Map<string, Promise<boolean>>()
  private readonly memory: SessionMemory
  private readonly emit: (event: WireValue) => void

  constructor(
    memory: SessionMemory,
    emit: (event: WireValue) => void,
  ) {
    this.memory = memory
    this.emit = emit
  }

  private async owner(provider: string, nativeId: string): Promise<ConversationRoute | null> {
    const route = this.memory.routeForSession(provider, nativeId)
    if (route) return route
    const hold = this.memory.heldBy(provider, nativeId)
    // Older running builds already serve the required RPCs but did not record
    // their endpoint. Resolve that named process once without restarting it.
    const directories = (await readdir(tmpdir())).filter((name) => /^mako-host-[a-f0-9]{16}$/.test(name))
    for (let offset = 0; offset < Math.min(directories.length, 128); offset += 8) {
      const candidates = await Promise.all(directories.slice(offset, offset + 8).map(async (directory) => {
        const socket = join(tmpdir(), directory, "host.sock")
        try {
          await this.validateSocket(socket)
          const probe = await probeRuntime(socket, { timeoutMs: 1_000 })
          if (probe.state !== "ready" || probe.info.pid === process.pid) return null
          if (hold) return probe.info.pid === hold.hostPid ? { socket, hold } : null
          // Recover a missing ledger entry from a connected Mako driver.
          if (!probe.info.methods.includes("mako:live-locate")) return null
          const id = z.string().nullable().parse(await invokeRuntime(socket, this.client, "mako:live-locate", [provider, nativeId], 1, { timeoutMs: 1_000 }))
          const located = this.memory.heldBy(provider, nativeId)
          return id && located?.conversationId === id && located.hostPid === probe.info.pid ? { socket, hold: located } : null
        } catch { return null }
      }))
      const candidate = candidates.find((candidate) => candidate !== null)
      if (candidate) {
        const found = { conversationId: candidate.hold.conversationId, provider, nativeId, socket: candidate.socket }
        this.memory.rememberRoute(found, candidate.hold)
        return found
      }
    }
    return null
  }

  async attachment(provider: string, nativeId: string): Promise<string | null> {
    const route = await this.owner(provider, nativeId)
    return route && await this.reachable(route) ? route.conversationId : null
  }

  async attach(provider: string, nativeId: string): Promise<WireValue | null> {
    const route = await this.owner(provider, nativeId)
    if (!route || !await this.reachable(route)) return null
    await this.follow(route)
    const value = await invokeRuntime(route.socket, this.client, "mako:live-snapshot", [route.conversationId])
    if (value == null) return null
    const identity = snapshotIdentity.parse(value)
    // A disconnected summary can lose nativeId while its active binding keeps
    // the identity. Inactive bindings and conflicting summaries cannot attest it.
    const binding = identity.control?.bindings.find((entry) => entry.id === identity.control?.activeBindingId)
    const matchesNative = identity.session.nativeId === nativeId ||
      (identity.session.nativeId === undefined && binding?.provider === provider && binding.nativeId === nativeId)
    if (identity.session.id !== route.conversationId || identity.session.harness !== provider || !matchesNative)
      throw new Error("The session owner changed. Reopen this thread to continue.")
    return value
  }

  async route(channel: string, args: unknown[]): Promise<ConversationRoutingResult> {
    let id: string | undefined
    if (conversationCalls.has(channel)) id = z.string().parse(args[0])
    else if (channel === "mako:thread-controls" || channel === "mako:thread-stop") {
      const target = liveTarget.safeParse(args[0])
      if (target.success) id = target.data.id
    }
    if (!id) return { handled: false }
    const route = this.memory.routeForConversation(id)
    if (!route) return { handled: false }
    if (!await this.reachable(route)) throw new RuntimeDisconnectedError(false)
    await this.follow(route)
    // Preserve the original request id. The owner's journal settles a replay;
    // this router never retries a mutation after an ambiguous transport error.
    const value = await invokeRuntime(route.socket, this.client, channel, args)
    if (channel === "mako:live-fork") {
      const fork = snapshotIdentity.parse(value)
      const input = z.object({ id: z.string(), provider: z.string() }).parse(args[1])
      if (fork.session.id !== input.id || fork.session.harness !== input.provider)
        throw new Error("The conversation owner returned a different fork")
      // A fork has a journal before it has a native provider session. Record
      // its endpoint even when the owner is an older build without this table.
      this.memory.rememberJournal(fork.session.id, route.socket)
      await this.follow({ conversationId: fork.session.id, socket: route.socket })
    }
    return { handled: true, value }
  }

  private async reachable(route: ConversationEndpoint): Promise<boolean> {
    const probe = await probeRuntime(route.socket, { timeoutMs: 1_000 })
    if (probe.state === "ready") {
      await this.validateSocket(route.socket)
      return probe.info.methods.includes("mako:live-snapshot")
    }
    if (probe.state !== "absent") return false
    const launch = this.memory.runtimeLaunch(route.socket)
    if (!launch) return false
    if (runtimeLocation(launch.dataRoot).socket !== route.socket)
      throw new Error("The saved conversation host does not match its data directory")
    let waking = this.waking.get(route.socket)
    if (!waking) {
      const env = { ...process.env, MAKO_PROFILE: launch.profile, ELECTRON_RUN_AS_NODE: undefined, MAKO_STANDALONE: undefined }
      // Only an absent socket permits a restart. ensureRuntime retains the
      // owner's data root and single-instance lock; an unreachable live host
      // never authorizes a replacement or a different provider process.
      waking = ensureRuntime({ ...launch, env }).then(() => true).finally(() => this.waking.delete(route.socket))
      this.waking.set(route.socket, waking)
    }
    return waking
  }

  private async validateSocket(socket: string): Promise<void> {
    const [directory, endpoint] = await Promise.all([lstat(dirname(socket)), lstat(socket)])
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      !endpoint.isSocket() || (endpoint.mode & 0o077) !== 0 ||
      (process.getuid && (directory.uid !== process.getuid() || endpoint.uid !== process.getuid())))
      throw new Error("The conversation host socket is not private to this user")
  }

  private async follow(route: ConversationEndpoint): Promise<void> {
    let peer = this.peers.get(route.socket)
    if (!peer) {
      try { await this.validateSocket(route.socket) }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          throw new RuntimeDisconnectedError(false)
        throw error
      }
      // Recheck after filesystem I/O: concurrent sends share one subscription.
      peer = this.peers.get(route.socket)
      if (!peer) {
        peer = { ids: new Set(), ready: Promise.resolve(), resolveReady: () => {}, disconnected: false, connecting: false, observerSupported: false, generation: 0, retryDelayMs: 1_000 }
        this.peers.set(route.socket, peer)
        this.connect(route.socket, peer)
      }
    }
    if (peer.disconnected && !peer.connecting) {
      clearTimeout(peer.retry)
      peer.stop?.()
      this.connect(route.socket, peer)
    }
    peer.ids.add(route.conversationId)
    // Subscribe before reading a snapshot or accepting a prompt, so no updates
    // can fall into a gap between the snapshot and event stream.
    await peer.ready
    if (this.closed || peer.disconnected) throw new RuntimeDisconnectedError(false)
  }

  private connect(socket: string, peer: Peer): void {
    if (this.closed) return
    const generation = ++peer.generation
    peer.connecting = true
    peer.ready = new Promise<void>((resolve) => { peer.resolveReady = resolve })
    let ended = false
    const disconnected = () => {
      if (ended || this.closed || peer.generation !== generation) return
      ended = true
      peer.connecting = false
      clearTimeout(peer.handshake)
      peer.stop?.()
      peer.resolveReady()
      if (!peer.disconnected) this.emit({ type: "live-owner-connection", ids: [...peer.ids], connected: false })
      peer.disconnected = true
      peer.retry = setTimeout(() => { this.connect(socket, peer) }, peer.retryDelayMs)
      peer.retryDelayMs = Math.min(10_000, peer.retryDelayMs * 2)
      peer.retry.unref()
    }
    peer.handshake = setTimeout(disconnected, 5_000)
    peer.handshake.unref()
    peer.stop = subscribeRuntime(socket, this.client, (packet) => {
      if (this.closed || peer.generation !== generation) return
      if (packet.channel === "ready") {
        peer.connecting = false
        peer.retryDelayMs = 1_000
        peer.observerSupported = packet.runtime?.methods.includes("mako:live-attach") ?? false
        clearTimeout(peer.handshake)
        peer.resolveReady()
        if (peer.disconnected) {
          peer.disconnected = false
          this.emit({ type: "live-owner-connection", ids: [...peer.ids], connected: true })
        }
      } else if (packet.channel === "event") {
        const shutdown = shutdownRequest.safeParse(packet.payload)
        if (shutdown.success && !peer.observerSupported) {
          // Old hosts count every stream as a window. This observer owns no
          // drafts; acknowledge only its own client identity, never a UI's.
          void invokeRuntime(socket, this.client, "mako:shutdown-ack", [shutdown.data.requestId]).catch(() => {})
        }
        const event = batchIdentity.safeParse(packet.payload)
        if (event.success && peer.ids.has(event.data.batch.id) &&
          this.memory.routeForConversation(event.data.batch.id)?.socket === socket)
          this.emit(packet.payload)
      }
    }, disconnected, { observer: true })
  }

  dispose(): void {
    this.closed = true
    for (const peer of this.peers.values()) {
      clearTimeout(peer.retry)
      clearTimeout(peer.handshake)
      peer.stop?.()
      peer.resolveReady()
    }
    this.peers.clear()
  }
}
