/**
 * What a failed turn means for the person reading it.
 *
 * A provider hands Mako one string. Some of those strings describe a fault
 * that a second attempt cannot fix — the model API refused the session's own
 * history, the context is full, the account is signed out — and offering
 * "Send again" for them is a lie that costs a round trip. Others are
 * transient and are worth exactly that button. The classifier reads the
 * string once, on the host, and the request carries the verdict; the
 * renderer never pattern-matches error text.
 *
 * Kept free of imports so the renderer and the host share it.
 */
export const PROVIDER_FAILURE_KINDS = [
  /** The model API refused the session's saved history; only a new session escapes it. */
  "transcript-rejected",
  /** The conversation no longer fits the model's context window. */
  "context-exhausted",
  /** The provider's account is signed out, the key is invalid, or a plan does not cover the model. */
  "auth",
  /** The provider throttled or is over capacity; the same message works later. */
  "rate-limited",
  /** The provider's service failed on its side; the same message works later. */
  "provider-unavailable",
  /** The connection to the provider dropped; the same message works later. */
  "network",
  /** Mako could not reopen the native session; the transcript is intact, the session is not. */
  "resume-failed",
  /** The prompt itself was refused before it ran (empty, too large, an unsupported attachment). */
  "rejected-input",
  "unknown",
] as const
export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number]

export interface ProviderFailure {
  kind: ProviderFailureKind
  /** Whether sending the same message again can succeed. */
  retriable: boolean
  /** One sentence naming what happened, with the provider named where it matters. */
  title: string
  /** What to do about it. */
  guidance: string
}

interface Rule {
  kind: ProviderFailureKind
  match: RegExp
}

/**
 * Order matters: the first rule that matches wins, and the specific faults
 * (a rejected transcript names request items; a context overflow names
 * tokens) precede the broad HTTP families they could also trip.
 */
const rules: Rule[] = [
  {
    kind: "transcript-rejected",
    match:
      /encrypted_content|reasoning item|of type ['"`]?reasoning['"`]?|required following item|was not issued to this caller|previous_response(?:_id)?[^.]*not found|item (?:with id )?['"`]?[\w-]+['"`]? (?:was )?not found|no tool call found for|tool_result.*tool_use|tool_use.*tool_result|does not have a corresponding|corresponding tool_use|unexpected role|invalid (?:message )?(?:sequence|ordering)|(?:conversation|message) history (?:is|was) (?:invalid|rejected|corrupt)|first message must|must alternate|malformed (?:messages|transcript)|invalid_request_error.*(?:messages|input\[)/i,
  },
  {
    kind: "context-exhausted",
    match:
      /context[_ ]?(?:window|length|limit)|prompt is too long|too many tokens|maximum (?:context|number of tokens)|exceeds? the (?:model|maximum|context)|input (?:length|is too long)|token limit|max_tokens.*exceed|request too large|content too large/i,
  },
  {
    kind: "auth",
    match:
      /\b401\b|\b403\b|unauthori[sz]ed|authentication|auth_required|invalid (?:api[_ ]?key|token|credentials)|api[_ ]?key|not (?:logged|signed) in|(?:log|sign) in (?:again|to)|login required|credentials|token (?:has )?expired|expired token|subscription|billing|payment required|insufficient (?:permissions|scope|credits)|plan does not/i,
  },
  {
    kind: "rate-limited",
    match:
      /\b429\b|\b529\b|rate[_ ]?limit|too many requests|quota|overloaded|over capacity|capacity|resource[_ ]exhausted|usage limit|throttl|try again (?:in|later|shortly)|retry after/i,
  },
  {
    kind: "provider-unavailable",
    match:
      /\b50[0234]\b|internal server error|service unavailable|bad gateway|gateway timeout|upstream|server error|temporarily unavailable|api error|provider (?:returned|error)|\[(?:unavailable|internal)\]/i,
  },
  {
    // The bracketed codes are Connect RPC's, as cursor-agent prints them:
    // `[canceled] http/2 stream closed with error code CANCEL (0x8)`.
    kind: "network",
    match:
      /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|network (?:error|failure|request)|socket hang up|connection (?:reset|refused|closed|lost|error|stalled|failed)|timed? ?out|terminated|stream (?:ended|closed)|other side closed|http\/2|\[(?:canceled|cancelled|deadline_exceeded)\]/i,
  },
  {
    kind: "resume-failed",
    match:
      /session (?:not found|could not be|cannot be|is no longer|was not)|could not be resumed|cannot be resumed|resume(?:d|s)? (?:failed|refused)|failed to (?:resume|reopen|load the session)|(?:thread|conversation) (?:not found|is unavailable)|unknown session|saved binding|session store|held by|has this session open|session is live in/i,
  },
  {
    kind: "rejected-input",
    match:
      /cannot be empty|empty prompt|unsupported (?:attachment|mime|file)|attachment (?:too|exceeds)|invalid params|invalid_params|unknown model|model (?:not found|is not available|unavailable)/i,
  },
]

export function classifyProviderFailure(
  message: string | undefined,
  providerLabel = "The provider"
): ProviderFailure {
  const text = message ?? ""
  const kind = rules.find((rule) => rule.match.test(text))?.kind ?? "unknown"
  return describeProviderFailure(kind, providerLabel)
}

/**
 * A start that failed with a recognisable cause (signed out, over capacity)
 * keeps that cause; one that failed for no classifiable reason while
 * reopening a session is Mako's failure to resume, not the provider's.
 */
export function classifyStartFailure(message: string | undefined, resuming: boolean): ProviderFailureKind {
  const kind = classifyProviderFailure(message).kind
  return kind === "unknown" && resuming ? "resume-failed" : kind
}

export function describeProviderFailure(
  kind: ProviderFailureKind,
  providerLabel = "The provider"
): ProviderFailure {
  switch (kind) {
    case "transcript-rejected":
      return {
        kind,
        retriable: false,
        title: `${providerLabel}'s session history was rejected by its model provider`,
        guidance: `Sending again will not help: the model API refuses this session's saved history. Start a new ${providerLabel} thread; the transcript here stays readable.`,
      }
    case "context-exhausted":
      return {
        kind,
        retriable: false,
        title: `${providerLabel}'s context window is full`,
        guidance: "Compact the conversation or start a new thread and carry over what matters.",
      }
    case "auth":
      return {
        kind,
        retriable: false,
        title: `${providerLabel} is signed out or this account cannot use the selected model`,
        guidance: `Sign in to ${providerLabel} again, or choose a model the account covers, then send the message.`,
      }
    case "rate-limited":
      return {
        kind,
        retriable: true,
        title: `${providerLabel} is over its rate limit or capacity`,
        guidance: "The same message works once the limit resets. Nothing was lost.",
      }
    case "provider-unavailable":
      return {
        kind,
        retriable: true,
        title: `${providerLabel}'s service failed on its side`,
        guidance: "Send the message again in a moment.",
      }
    case "network":
      return {
        kind,
        retriable: true,
        title: `The connection to ${providerLabel} dropped`,
        guidance: "Send the message again; the session itself is intact.",
      }
    case "resume-failed":
      return {
        kind,
        retriable: false,
        title: `Mako could not reopen this ${providerLabel} session`,
        guidance: "The transcript is saved. Continue it as a new thread, or wait for the process that has it open to finish.",
      }
    case "rejected-input":
      return {
        kind,
        retriable: false,
        title: `${providerLabel} refused the message before running it`,
        guidance: "Change the message, its attachments or the selected model and send it again.",
      }
    case "unknown":
      return {
        kind,
        retriable: true,
        title: `${providerLabel} did not finish this turn`,
        guidance: "Send the message again. If it fails the same way, the provider's own error above says why.",
      }
  }
}
