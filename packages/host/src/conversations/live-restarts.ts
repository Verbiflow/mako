import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"
import { errorMessage } from "../base/error-message.js"
import { hostWarn } from "../base/host-log.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { ConversationSettings } from "../contracts/turn-continuation.js"
import type { LiveSnapshot, LiveRequest } from "../contracts/live-conversations.js"
import { holdOf } from "../contracts/request-hold.js"

const SettingsFileSchema = z.object({ version: z.literal(1), continueAfterRestart: z.boolean() })
const LeftFileSchema = z.object({
  version: z.literal(1),
  turns: z.array(z.object({
    conversationId: z.string(), requestId: z.string(), always: z.literal(true).optional(),
    waiting: z.array(z.object({ id: z.string(), inputDigest: z.string() })).optional(),
  })),
})

/**
 * A turn the host's exit cut short (`host-quit`), for the next host to
 * continue. `always`: a child's, which its parent waits on, so it continues
 * whatever the person chose for their own; `RESTART_CHAIN` still bounds it.
 */
export type LeftTurn = z.infer<typeof LeftFileSchema>["turns"][number]

const DEFAULTS: ConversationSettings = { continueAfterRestart: true }

/**
 * The person's conversation settings, and the turns Mako's own quit, restart
 * or update cut short, which the next host continues unless the person chose
 * otherwise. The journal holds each turn and why it stopped; the list says
 * which journals to open, so the next host reads none it doesn't continue.
 * It stays until the continuation and backlog have an executor or their own durable hold, across further restarts.
 */
export class LiveRestarts {
  readonly #settingsFile: string
  readonly #leftFile: string
  readonly #emit: (event: HostEvent) => void
  #settings: ConversationSettings
  #turns: LeftTurn[]

  constructor(root: string, emit: (event: HostEvent) => void) {
    this.#settingsFile = join(root, "settings.json")
    this.#leftFile = join(root, "left-at-exit.json")
    this.#emit = emit
    this.#settings = this.#read()
    this.#turns = this.#readLeft()
  }

  settings(): ConversationSettings {
    return this.#settings
  }

  set(settings: ConversationSettings): ConversationSettings {
    this.#settings = { continueAfterRestart: settings.continueAfterRestart }
    write(this.#settingsFile, JSON.stringify(SettingsFileSchema.parse({ version: 1, ...this.#settings })))
    this.#emit({ type: "conversation-settings", settings: this.#settings })
    return this.#settings
  }

  /** The host is stopping: the turns its exit cut short, kept for the next host while the person wants them continued, beside those an earlier close of this host's left. */
  leave(turns: readonly LeftTurn[]): void {
    const kept = this.#settings.continueAfterRestart ? turns : turns.filter((turn) => turn.always)
    if (!kept.length) return
    try {
      const earlier = this.#left().filter((turn) => !kept.some((cut) => cut.conversationId === turn.conversationId))
      const turns = [...earlier, ...kept]
      write(this.#leftFile, JSON.stringify(LeftFileSchema.parse({ version: 1, turns })))
      this.#turns = turns
    } catch (error) {
      hostWarn("live", "the turns Mako's exit cut short weren't kept for the next start; they wait for Continue turn", { error: errorMessage({ error }) })
    }
  }

  /** This exact recovery is owned elsewhere or explicitly withdrawn. Reading and queue admission do not settle it. */
  finish(conversationId: string, requestId: string): void {
    const held = this.#left()
    if (!held.some((turn) => turn.conversationId === conversationId && turn.requestId === requestId)) return
    const turns = held.filter((turn) => turn.conversationId !== conversationId || turn.requestId !== requestId)
    if (turns.length) write(this.#leftFile, JSON.stringify(LeftFileSchema.parse({ version: 1, turns })))
    else rmSync(this.#leftFile, { force: true })
    this.#turns = turns
  }

  /** A queued row is durable but not yet owned by an executor or a timed hold. Keep its exit recovery until then. */
  handed(snapshot: LiveSnapshot): void {
    const waiting = (request: LiveRequest | undefined) => {
      if (request?.status === "queued") return true
      if (request?.status === "dispatching" && !request.nativeRun && request.nativeDelivery?.evidence.kind !== "accepted") return true
      const hold = request && holdOf(request)
      return hold?.kind === "paused" && hold.by === "mako"
    }
    for (const turn of this.#turns) {
      if (turn.conversationId !== snapshot.session.id) continue
      const source = snapshot.requests.find((request) => request.id === turn.requestId)
      const continuation = snapshot.requests.find((request) => request.continues?.requestId === turn.requestId)
      const ownsContinuation = source?.status === "completed" || (continuation && !waiting(continuation))
      const inputs = new Map(turn.waiting?.map((row) => [row.id, row.inputDigest]))
      const backlog = snapshot.requests.some((request) => inputs.get(request.id) === request.inputDigest && inputs.has(request.id) && waiting(request))
      if (ownsContinuation && !backlog) {
        try { this.finish(turn.conversationId, turn.requestId) }
        catch (error) { hostWarn("live", "a handed continuation's restart index could not be retired; its journal prevents replay", { conversation: turn.conversationId, error: errorMessage({ error }) }) }
      }
    }
  }

  /** An explicit Close withdraws this conversation's outstanding restart intent. */
  discard(conversationId: string): void {
    for (const turn of this.#left())
      if (turn.conversationId === conversationId) this.finish(conversationId, turn.requestId)
  }

  /** Cuts still owed a continuation, read without consuming their durable intent. */
  left(): LeftTurn[] {
    const turns = this.#left()
    return this.#settings.continueAfterRestart ? turns : turns.filter((turn) => turn.always)
  }

  #left(): LeftTurn[] {
    return this.#turns
  }

  #readLeft(): LeftTurn[] {
    if (!existsSync(this.#leftFile)) return []
    try {
      return LeftFileSchema.parse(JSON.parse(readFileSync(this.#leftFile, "utf8"))).turns
    } catch (error) {
      hostWarn("live", "the turns the last exit cut short couldn't be read; they wait for Continue turn", { error: errorMessage({ error }) })
      return []
    }
  }

  #read(): ConversationSettings {
    if (!existsSync(this.#settingsFile)) return DEFAULTS
    try {
      const { continueAfterRestart } = SettingsFileSchema.parse(JSON.parse(readFileSync(this.#settingsFile, "utf8")))
      return { continueAfterRestart }
    } catch (error) {
      hostWarn("live", "conversation settings couldn't be read; the defaults stand", { error: errorMessage({ error }) })
      return DEFAULTS
    }
  }
}

function write(file: string, json: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, json, { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}
