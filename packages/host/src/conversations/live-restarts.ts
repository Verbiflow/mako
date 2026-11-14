import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"
import { errorMessage } from "../base/error-message.js"
import { hostWarn } from "../base/host-log.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { ConversationSettings } from "../contracts/turn-continuation.js"

const SettingsFileSchema = z.object({ version: z.literal(1), continueAfterRestart: z.boolean() })
const LeftFileSchema = z.object({
  version: z.literal(1),
  turns: z.array(z.object({ conversationId: z.string(), requestId: z.string(), always: z.literal(true).optional() })),
})

/**
 * A turn the host's exit cut short (`host-quit`), for the next host to
 * continue. `always`: a child's, which its parent waits on, so it continues
 * whatever the person chose for their own; `RESTART_CHAIN` still bounds it.
 */
export type LeftTurn = z.infer<typeof LeftFileSchema>["turns"][number]

const DEFAULTS: ConversationSettings = { continueAfterRestart: false }

/**
 * The person's conversation settings, and the turns Mako's own quit, restart
 * or update cut short, which the next host continues when the person chose
 * so. The journal holds each turn and why it stopped; the list only says
 * which journals to open, so the next host reads none it doesn't continue.
 * It is written as the host stops and taken, once, as the next one starts.
 */
export class LiveRestarts {
  readonly #settingsFile: string
  readonly #leftFile: string
  readonly #emit: (event: HostEvent) => void
  #settings: ConversationSettings

  constructor(root: string, emit: (event: HostEvent) => void) {
    this.#settingsFile = join(root, "settings.json")
    this.#leftFile = join(root, "left-at-exit.json")
    this.#emit = emit
    this.#settings = this.#read()
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
      write(this.#leftFile, JSON.stringify(LeftFileSchema.parse({ version: 1, turns: [...earlier, ...kept] })))
    } catch (error) {
      hostWarn("live", "the turns Mako's exit cut short weren't kept for the next start; they wait for Continue turn", { error: errorMessage({ error }) })
    }
  }

  /** What the host before this one left, once: the list goes as it is read, and nothing is continued unless the person still wants it. */
  take(): LeftTurn[] {
    if (!existsSync(this.#leftFile)) return []
    const turns = this.left()
    rmSync(this.#leftFile, { force: true })
    return turns
  }

  /** What `take` would take, left where it is. */
  left(): LeftTurn[] {
    const turns = this.#left()
    return this.#settings.continueAfterRestart ? turns : turns.filter((turn) => turn.always)
  }

  #left(): LeftTurn[] {
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
