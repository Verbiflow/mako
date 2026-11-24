import { TreeNoticeAnswerSchema, machineNoticesPath, type TreeNoticeAnswer } from "@mako/protocol/tree-notices"
import { errorMessage } from "../base/error-message.js"
import { hostStopping, untilStopped } from "../base/host-stopping.js"
import type { NoticePost, NoticePosted } from "./agent-places.js"

/** Where a cloud machine reaches the account, and as whom: its machine's link. */
export type NoticeLink = { gatewayUrl: string; machine: string; credential: string }

/** How long one post waits for the account's answer, which it gives at once: admitted or refused, never delivered first. */
const POST_MS = 30_000

/**
 * A cloud machine's posts of its Fin's notices to the account (`machineNoticesPath`), on the machine's credential as
 * its link holds it now: a renewed one is used from the next post. The account answers at once with the notice's
 * number or why not (`TreeNoticeAnswerSchema`), a `rate` refusal saying how long to wait (`retry-after`, in seconds);
 * 401 is a credential it no longer takes; anything else is no answer. A post is the host's work, ended with it.
 */
export function accountNotices(link: () => NoticeLink | null, fetching: typeof fetch = fetch, owner: AbortSignal | undefined = hostStopping()?.signal): NoticePost {
  return {
    post: async (body): Promise<NoticePosted> => {
      const linked = link()
      if (!linked) return { kind: "failed", why: "this machine isn't linked to Mako's cloud yet" }
      const lifetime = owner ?? hostStopping()?.signal
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(POST_MS), ...(lifetime ? [lifetime] : [])])
      try {
        signal.throwIfAborted()
        const url = new URL(machineNoticesPath(linked.machine), linked.gatewayUrl)
        const headers = { authorization: `Bearer ${linked.credential}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }
        const response = await untilStopped(fetching(url, { method: "POST", headers, body, signal }), signal)
        if (response.status === 401) return { kind: "unauthorized" }
        if (!response.ok) return { kind: "failed", why: `Mako's cloud answered ${response.status}` }
        const answer = answerOf(await untilStopped(response.text(), signal))
        if (!answer) return { kind: "failed", why: "Mako's cloud answered something this Mako can't read" }
        const seconds = Number(response.headers.get("retry-after"))
        return { kind: "answered", answer, ...(Number.isFinite(seconds) && seconds > 0 && { retryAfterMs: Math.ceil(seconds * 1_000) }) }
      } catch (error) {
        // The failure's own words, which name the network or the deadline and never what was sent with it.
        return { kind: "failed", why: errorMessage({ error }) }
      } finally {
        // An unread body ends with its post; no request outlives it on its deadline alone.
        controller.abort()
      }
    },
  }
}

/** The account's answer to a post, read from its body; undefined when the body isn't JSON or isn't one. */
function answerOf(text: string): TreeNoticeAnswer | undefined {
  try {
    return TreeNoticeAnswerSchema.safeParse(JSON.parse(text)).data
  } catch {
    // Not JSON: no answer.
    return undefined
  }
}
