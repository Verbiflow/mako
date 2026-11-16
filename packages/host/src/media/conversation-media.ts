import { realpath } from "node:fs/promises"
import type { Entry } from "@mako/sessions/entries"
import { turnMedia, type MediaCandidate } from "@mako/sessions/turn-media"
import type { MediaCheck, MediaConfirmation } from "../contracts/turn-media.js"
import type { TurnMedia } from "./turn-media.js"

/** A conversation's history as its host holds it: the harness it ran on, and every entry, base and live. */
export type ConversationHistory = { harness: string; entries: readonly Entry[] }

/** Said of a check that names no file of this conversation's records. */
export const NOT_THIS_CONVERSATIONS = "This conversation's records don't name that file"

/**
 * A conversation's turn media, judged by its own records, for another device: what it may have kept
 * (`mako:live-turn-media`) and read (`mako:read-live-file` of a kept copy). A device names files and calls; the host
 * keeps only those its records state (`turnMedia`), with the records' evidence, never the device's, and serves from
 * Mako's media store only the copies those records were kept as. Another conversation's copies, and the rest of the
 * store, stay this Mac's.
 */
export class ConversationMedia {
  readonly #media: TurnMedia
  readonly #history: (conversation: string) => Promise<ConversationHistory | null>

  constructor(media: TurnMedia, history: (conversation: string) => Promise<ConversationHistory | null>) {
    this.#media = media
    this.#history = history
  }

  /** Each asked check's answer, in order: a file the conversation's records name, confirmed as they state it. */
  async confirm(conversation: string, asked: readonly Pick<MediaCheck, "callId" | "path">[]): Promise<MediaConfirmation[]> {
    const named = await this.#named(conversation)
    const checks = asked.map((check) => named.get(`${check.callId}\0${check.path}`))
    const answers = await this.#media.confirm(checks.flatMap((check) => (check ? [check] : [])))
    let next = 0
    return checks.map((check) => (check ? answers[next++]! : { kind: "dropped", reason: NOT_THIS_CONVERSATIONS }))
  }

  /** Whether `real`, a resolved path, is the copy Mako kept of a file this conversation's records name. */
  async kept(conversation: string, real: string): Promise<boolean> {
    const named = [...(await this.#named(conversation)).values()]
    const answers = await this.#media.answered(named)
    for (const answer of answers) {
      if (answer?.kind !== "kept" || !answer.media.digest) continue
      if ((await realpath(answer.media.file).catch(() => undefined)) === real) return true
    }
    return false
  }

  /** The checks the conversation's records state, by call and path. */
  async #named(conversation: string): Promise<Map<string, MediaCheck>> {
    const history = await this.#history(conversation)
    const named = new Map<string, MediaCheck>()
    if (!history) return named
    for (const candidate of turnMedia(history.entries, history.harness)) {
      const check = recordCheck(candidate)
      if (check) named.set(`${check.callId}\0${check.path}`, check)
    }
    return named
  }
}

/** A record's candidate as the check the host keeps it by; none for bytes the call returned itself. */
function recordCheck(candidate: MediaCandidate): MediaCheck | undefined {
  if (!candidate.path?.startsWith("/") || candidate.evidence === "attached") return undefined
  const check: MediaCheck = { callId: candidate.callId, path: candidate.path, evidence: candidate.evidence }
  if (candidate.startedAt !== undefined) check.startedAt = Math.round(candidate.startedAt)
  if (candidate.endedAt !== undefined) check.endedAt = Math.round(candidate.endedAt)
  if (candidate.digest) check.digest = candidate.digest
  return check
}
