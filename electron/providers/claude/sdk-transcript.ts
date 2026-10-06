import { open, readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import type { HookCallback, SDKMessage } from "@anthropic-ai/claude-agent-sdk"

const ChainEntry = z.object({
  uuid: z.string().uuid(),
  parentUuid: z.string().uuid().nullable(),
  sessionId: z.string(),
  isSidechain: z.boolean().optional(),
})
const ChainLink = z.object({ parentUuid: z.json() })
const PersistedHead = z.object({
  type: z.literal("last-prompt"),
  sessionId: z.string(),
  leafUuid: z.string().uuid(),
})
const tailBytes = 16 * 1024 * 1024
const recordBytes = 1024 * 1024

/** The SDK supplies the account-scoped transcript path through its lifecycle hook. */
export class ClaudeTranscript {
  path: string | undefined
  private lastMessageId: string | undefined

  /** The account's Claude home the process runs under. */
  private readonly configDir: string | undefined

  /** Told the path when a hook first reports it or a new one, so the binding records it mid-turn. */
  private readonly located: ((path: string) => void) | undefined

  constructor(configDir?: string, located?: (path: string) => void) {
    this.configDir = configDir
    this.located = located
  }

  readonly hook: HookCallback = async (input) => {
    if (input.agent_id || input.transcript_path === this.path) return {}
    this.path = input.transcript_path
    this.located?.(input.transcript_path)
    return {}
  }

  /**
   * The transcript path, found by the session's file name when no hook has
   * reported it: a fresh session's hooks report it only when its first turn
   * ends, and a process that dies in that turn must still leave the record
   * it resumes from. Session IDs are unique across project folders.
   */
  async locate(sessionId: string | undefined): Promise<string | undefined> {
    if (this.path || !sessionId || !this.configDir) return this.path
    const root = join(this.configDir, "projects")
    for (const project of await readdir(root).catch(() => [])) {
      const candidate = join(root, project, `${sessionId}.jsonl`)
      if (await stat(candidate).then((entry) => entry.isFile(), () => false)) return (this.path = candidate)
    }
    return undefined
  }

  reset(): void {
    this.lastMessageId = undefined
  }

  /** `/clear` continues under a new session ID and file; a path for the old one no longer applies. */
  follow(sessionId: string): void {
    if (this.path && basename(this.path) !== `${sessionId}.jsonl`) this.path = undefined
    this.lastMessageId = undefined
  }

  observe(message: SDKMessage): void {
    if (
      (message.type === "assistant" || message.type === "user") &&
      !message.parent_tool_use_id &&
      message.uuid
    )
      this.lastMessageId = message.uuid
  }

  async forkPoint(sessionId: string | undefined): Promise<string | undefined> {
    if (
      !this.path ||
      !this.lastMessageId ||
      !sessionId ||
      basename(this.path) !== `${sessionId}.jsonl`
    )
      return undefined
    // A streamed result can precede the native writer's flush. Keep this turn
    // closed to new input while waiting briefly for its observed answer to land.
    const deadline = Date.now() + 1000
    do {
      const point = await readClaudeForkPoint(
        this.path,
        sessionId,
        this.lastMessageId
      )
      if (point) return point
      await delay(25)
    } while (Date.now() < deadline)
    return undefined
  }
}

/** Keep the final chain entry, including output attachments after the assistant.
 * Missing, oversized, torn or changing evidence disables native forking for this turn.
 */
export async function readClaudeForkPoint(
  path: string,
  sessionId: string,
  observedId: string
): Promise<string | undefined> {
  const file = await open(path, "r").catch(() => undefined)
  if (!file) return undefined
  try {
    const before = await file.stat()
    if (!before.isFile()) return undefined
    const offset = Math.max(0, before.size - tailBytes)
    const buffer = Buffer.alloc(Math.min(before.size, tailBytes))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
    if (!bytesRead || buffer[bytesRead - 1] !== 10) return undefined
    let start = offset ? buffer.indexOf(10) + 1 : 0
    if (offset && !start) return undefined
    let head: string | undefined
    let persistedHead: string | undefined
    while (start < bytesRead) {
      const end = buffer.indexOf(10, start)
      if (end < 0 || end >= bytesRead) return undefined
      const length = end - start
      if (length > recordBytes) {
        if (head) return undefined
      } else if (length) {
        let value: unknown
        try {
          value = JSON.parse(buffer.toString("utf8", start, end))
        } catch {
          if (head) return undefined
        }
        const entry = ChainEntry.safeParse(value)
        const persisted = PersistedHead.safeParse(value)
        if (persisted.success && persisted.data.sessionId === sessionId)
          persistedHead = persisted.data.leafUuid
        if (head && !entry.success && ChainLink.safeParse(value).success)
          return undefined
        if (entry.success && !entry.data.isSidechain) {
          if (entry.data.sessionId !== sessionId) return undefined
          if (entry.data.uuid === observedId) head = observedId
          else if (head) {
            if (entry.data.parentUuid !== head) return undefined
            head = entry.data.uuid
          }
        }
      }
      start = end + 1
    }
    const after = await file.stat()
    return head === persistedHead &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs
      ? head
      : undefined
  } catch {
    return undefined
  } finally {
    await file.close()
  }
}
