import type { ProviderFailureEvidence } from "./provider-failure-evidence.js"
import { errorMessage, type FailureBoundary } from "./error-message.js"
import { nativeVerificationPending } from "./native-verification-message.js"

/**
 * Host failures carry their kind. Only native decoders and transports admit provider text for classification;
 * mixed host catches never guess a cause from prose. The request retains that verdict for every renderer.
 * Browser-safe: no host or provider SDK runtime imports.
 */
export const PROVIDER_FAILURE_KINDS = [
  /** The model API refused the session's saved history; only a new session escapes it. */
  "transcript-rejected",
  /** The conversation no longer fits the model's context window. */
  "context-exhausted",
  /** The native protocol says the model declined this request; never inferred from assistant prose. */
  "model-refusal",
  /** The provider's account is signed out or its key is invalid; signing in again fixes it. */
  "auth",
  /** The provider explicitly refused this account's permission, scope or organisation access. */
  "permission",
  /** Automatic recovery could not confirm sign-in before its retry budget ended. */
  "sign-in-check",
  /** The account is signed in but its plan, billing or credits do not cover the request. */
  "plan",
  /** The agent reported a different signed-in identity than the account the session runs as; nothing was sent. */
  "wrong-account",
  /** The provider throttled or is over capacity; the same message works later. */
  "rate-limited",
  /** The provider's service failed on its side; the same message works later. */
  "provider-unavailable",
  /** The connection to the provider dropped; the same message works later. */
  "network",
  /** Mako could not reopen the native session; the transcript is intact, the session is not. */
  "resume-failed",
  /** A provider response exceeded the local transport bound, not model context. */
  "transport-limit",
  /** The prompt itself was refused before it ran (empty, too large, an unsupported attachment). */
  "rejected-input",
  /** The thread's folder is gone, so no provider can start in it. */
  "missing-folder",
  /** The agent's program would not start: missing, too old, or it quit on its own settings. */
  "launch-failed",
  /** The agent's program went quiet before it was ready; the same start often works. */
  "launch-stalled",
  "unknown",
] as const
export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number]

/** Host-owned failures are never quota evidence; only the provider can attest to quota. */
export const HOST_FAILURE_KINDS = ["unknown", "auth", "permission", "wrong-account", "missing-folder", "resume-failed", "launch-failed", "launch-stalled", "rejected-input", "transport-limit", "network"] as const
export type HostFailureKind = (typeof HOST_FAILURE_KINDS)[number]

export interface ProviderFailure {
  kind: ProviderFailureKind
  /** Whether an unchanged attempt may succeed. This is not delivery or replay-safety evidence. */
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
 * The words that say an account ran out rather than that a service is busy: `Your team has reached its usage limit`,
 * `You've hit your weekly limit · resets 1pm`, `Claude usage limit reached`, `Quota exhausted`.
 */
const USAGE_LIMIT = /^(?:(?:API Error|Error):\s*)?(?:(?:Claude(?: Code| AI)?|Codex|Cursor|Grok|Devin|OpenCode)[: ]+)?(?:you(?: have|'ve|’ve)? (?:hit|have hit|reached) (?:your|the) (?:[\w-]+ )?(?:usage |rate )?limit\b|your team has reached its (?:usage |rate )?limit\b|(?:usage limit|quota) (?:reached|hit|exhausted|exceeded)\b|usage_limit_(?:reached|exceeded)\b)/i
/** HTTP/JSON-RPC and the providers' native rate-error headings, not suggestions such as “retry after”. */
const RATE_LIMIT = /^(?:(?:API Error|HTTP(?: Error)?|Error):?\s*)?(?:429\b|rate_limit(?:_error|_exceeded|ed)\b|rate limit (?:reached|exceeded)\b|rate limited(?:[.:]|$)|too many requests\b|overloaded_error\b|resource_exhausted\b|\[resource_exhausted\])/i

/**
 * Claude prefixes temporary failures from its authentication request with "Failed to authenticate". Classify the
 * actual response, without checking or changing credentials. Explicit invalid-key/revocation text inside it still
 * wins under the ordinary rules. Unknown failures and ordinary 401/403 responses keep their authentication reading.
 */
function failureText(message: string | undefined): string {
  const text = message ?? ""
  const response = text.replace(/^Failed to authenticate[.:]\s*/i, "")
  if (response === text) return text
  const transient = /^(?:API Error:\s*)?(?:429|50[0234]|529)\b|^(?:fetch failed|(?:read )?ECONNRESET\b|ECONNREFUSED\b|ETIMEDOUT\b|ENOTFOUND\b|EAI_AGAIN\b|socket hang up)/i.test(response)
  return transient ? response : text
}

/**
 * Order matters: the first rule that matches wins, and the specific faults
 * (a rejected transcript names request items; a context overflow names
 * tokens) precede the broad HTTP families they could also trip.
 */
const rules: Rule[] = [
  {
    // MissingWorkingDirectoryError's own words, said before any provider starts.
    kind: "missing-folder",
    match: /no longer exists\. Open this in a folder that exists/,
  },
  {
    kind: "transport-limit",
    match: /oversized JSON-RPC message/i,
  },
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
    // ExecutionIdentityMismatch's own words, before "sign in again" reads as signed out.
    kind: "wrong-account",
    match: /is signed in as .+, not .+, the account this session started with/,
  },
  {
    // A signed-in account its plan refuses; before auth, whose 403 it could also trip.
    kind: "plan",
    match:
      /subscription|billing|payment required|\b402\b|insufficient (?:credits|balance|funds)|out of credits|credit balance|plan does not|not (?:included|available) (?:in|on|with) your plan|upgrade your plan/i,
  },
  {
    kind: "permission",
    match: /\bpermission_error\b|\boauth_org_not_allowed\b|\binsufficient (?:permissions?|scope)\b/i,
  },
  {
    kind: "auth",
    match:
      /\b401\b|\b403\b|unauthori[sz]ed|unauthenticated|authentication|failed to authenticate|oauth session (?:has )?expired|auth_required|invalid (?:api[_ ]?key|token|credentials)|api[_ ]?key|not (?:logged|signed) in|signed out|(?:log|sign) in (?:again|to)|login required|login (?:has )?expired|run \/login|credentials|token (?:has )?(?:expired|been revoked)|expired token|insufficient (?:permissions|scope)/i,
  },
  {
    // Anthropic's HTTP overload response is service trouble, not evidence that an account used its quota.
    kind: "provider-unavailable",
    match: /^(?:API Error:\s*|HTTP\s+)?529\b/i,
  },
  {
    kind: "rate-limited",
    match: RATE_LIMIT,
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
      /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|resume attempts made no progress|network (?:error|failure|request)|socket hang up|connection (?:reset|refused|closed|lost|error|stalled|failed)|timed? ?out|terminated|stream (?:ended|closed|disconnected)|other side closed|http\/2|\[(?:canceled|cancelled|deadline_exceeded)\]/i,
  },
  {
    kind: "resume-failed",
    match:
      /session (?:not found|could not be|cannot be|is no longer|was not)|no (?:conversation|session) found|could not be resumed|cannot be resumed|resume(?:d|s)? (?:failed|refused)|failed to (?:resume|reopen|load the session)|(?:thread|conversation) (?:not found|is unavailable)|unknown session|saved binding|session store|held by|has this session open|session is live in/i,
  },
  {
    // The startup watch's own words, after any cause its stderr named above.
    kind: "launch-failed",
    match:
      /\bexited (?:with code -?\d+ |on SIG[A-Z]+ )?(?:during|before) |process exited with code|\bENOENT\b|\bEACCES\b|executable not found|failed to spawn|spawn \S+ E[A-Z]+|requires Node(?:\.js)?|invalid MCP config|MCP config(?:uration)? file|invalid settings|settings file/i,
  },
  {
    kind: "launch-stalled",
    match: /produced no output for .* during |did not finish .+ within \d/i,
  },
  {
    kind: "rejected-input",
    match:
      /cannot be empty|empty prompt|unsupported (?:attachment|mime|file)|attachment (?:too|exceeds)|invalid params|invalid_params|unknown model|model (?:not found|is not available|unavailable)/i,
  },
]

/** The kinds a second attempt can't fix, whatever else the message says. */
const PERMANENT = new Set<ProviderFailureKind>([
  "transcript-rejected", "context-exhausted", "auth", "permission", "sign-in-check", "plan", "wrong-account", "rejected-input", "missing-folder", "transport-limit", "launch-failed",
])

/** A client error other than a timeout (408), a rate limit (429) or a plan's refusal (402), named by its status alone. */
const CLIENT_ERROR = /\b4\d\d (?:Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Not Acceptable|Conflict|Gone|Unprocessable)/i

/** Whether `text` names a fault only the person can fix, apart from what a plan covers. */
function personsFault(text: string): boolean {
  return rules.some((rule) => PERMANENT.has(rule.kind) && rule.kind !== "plan" && rule.match.test(text)) || CLIENT_ERROR.test(text)
}

/**
 * Whether `message` says an account ran out. A limit often suggests a bigger plan, and those words give way to it; any
 * other fault only the person can fix stands, whichever is said first: an invalid key doesn't clear at a reset.
 */
export function usageLimitWords(message: string | undefined): boolean {
  const text = failureText(message)
  return USAGE_LIMIT.test(text) && !personsFault(text)
}

/**
 * Whether `message` names a fault only the person can fix anywhere in it, before the first rule decides its kind:
 * a provider's "API error: 400 Bad Request: unknown model x" is a refused setting under a service's words.
 */
export function permanentFailure(message: string | undefined): boolean {
  const text = failureText(message)
  if (usageLimitWords(text)) return false
  return personsFault(text) || rules.some((rule) => rule.kind === "plan" && rule.match.test(text))
}

/** Native text is admitted only by a provider decoder/transport, never by a mixed host catch. */
export function classifyProviderText(message: string | undefined, providerLabel = "The provider"): ProviderFailure {
  const text = failureText(message)
  const kind = usageLimitWords(text) ? "rate-limited" : rules.find((rule) => rule.match.test(text))?.kind ?? "unknown"
  return describeProviderFailure(kind, providerLabel)
}

/** Missing provenance is a host failure of unknown kind; it is never guessed from its prose. */
export function classifyProviderFailure(message: string | undefined, providerLabel = "The provider", evidence?: ProviderFailureEvidence): ProviderFailure {
  if (!evidence) return describeProviderFailure("unknown", providerLabel)
  return evidence.source === "provider-error" && evidence.kind === "unknown"
    ? nativeVerificationPending(message ?? "") ? describeProviderFailure("launch-stalled", providerLabel) : classifyProviderText(message, providerLabel)
    : describeProviderFailure(evidence.kind, providerLabel)
}

export function providerTextEvidence(message: string | undefined): ProviderFailureEvidence {
  // Only native transports call this. Strip one known native error heading, never arbitrary enclosing prose.
  const native = message?.replace(/^(?:(?:stream error: exceeded retry limit, last status|unexpected status):?\s*|(?:AI_APICallError|Request failed|Grok):\s*)/i, "")
  const kind = classifyProviderText(native).kind
  if (native !== message && kind !== "unknown" && !personsFault(message ?? ""))
    return { kind, source: "provider-text" }
  return { kind: classifyProviderText(message).kind, source: "provider-text" }
}

/** A process exit is a network fact unless its own stderr supplies a known native cause. */
export function providerExitEvidence(stderr: string | undefined): ProviderFailureEvidence {
  const native = providerTextEvidence(stderr)
  return native.kind === "unknown" ? { kind: "network", source: "host" } : native
}

/**
 * A start that failed with a recognisable cause (signed out, over capacity)
 * keeps that cause; one that failed for no classifiable reason while
 * reopening a session is Mako's failure to resume, not the provider's.
 */
export function classifyStartFailure(message: string | undefined, resuming: boolean, evidence?: ProviderFailureEvidence): ProviderFailureKind {
  const kind = classifyProviderFailure(message, undefined, evidence).kind
  return evidence?.source === "host" ? kind : kind === "unknown" && resuming ? "resume-failed" : kind
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
    case "model-refusal":
      return {
        kind, retriable: false,
        title: `${providerLabel} declined the request`,
        guidance: "Choose another model to continue from the conversation; check prior work before repeating it.",
      }
    case "auth":
      return {
        kind,
        retriable: false,
        title: `${providerLabel} is signed out`,
        guidance: `Sign in to ${providerLabel} again, then send the message.`,
      }
    case "permission":
      return {
        kind, retriable: false,
        title: `${providerLabel} refused access`,
        guidance: `${providerLabel} refused this account's permission, scope or organisation access; choose an authorised account or ask its administrator for access.`,
      }
    case "sign-in-check":
      return {
        kind, retriable: false,
        title: `Check your ${providerLabel} sign-in`,
        guidance: "Mako could not confirm sign-in after an hour of automatic retries; sign in again in Settings › Agents, then resume the work.",
      }
    case "plan":
      return {
        kind,
        retriable: false,
        title: `${providerLabel}'s plan doesn't cover this request`,
        guidance: `Choose a model the plan covers or another account in Settings › Agents, or check the account's billing with ${providerLabel}.`,
      }
    case "wrong-account":
      return {
        kind,
        retriable: false,
        title: `${providerLabel} is signed in as a different account`,
        guidance: `Sign this session's account in to ${providerLabel} again, or choose the account ${providerLabel} is signed in as in Settings › Agents.`,
      }
    case "rate-limited":
      return {
        kind,
        retriable: true,
        title: `${providerLabel} is over its rate limit or capacity`,
        guidance: "Wait for capacity to return or choose another model.",
      }
    case "provider-unavailable":
      return {
        kind,
        retriable: true,
        title: `${providerLabel}'s service failed on its side`,
        guidance: "It usually recovers within minutes; the same message works then.",
      }
    case "network":
      return {
        kind,
        retriable: true,
        title: `The connection to ${providerLabel} failed or ended`,
        guidance: `The same message usually works once ${providerLabel} is reachable again.`,
      }
    case "transport-limit":
      return {
        kind,
        retriable: false,
        title: `Mako could not read a large response from ${providerLabel}`,
        guidance: "Your saved message is still here. This is a connection response-size limit, not a model context limit. Reopen the session after updating Mako.",
      }
    case "resume-failed":
      return {
        kind,
        retriable: false,
        title: `Mako could not reopen this ${providerLabel} session`,
        guidance: "The transcript and your message are kept; a new thread can carry on from here.",
      }
    case "rejected-input":
      return {
        kind,
        retriable: false,
        title: `${providerLabel} refused the message`,
        guidance: "Change the message, its attachments or the selected model and send it again.",
      }
    case "missing-folder":
      return {
        kind,
        retriable: false,
        title: "This thread's folder no longer exists",
        guidance: `${providerLabel} can't start in a folder that's gone. Restore the folder, or copy the message to a thread in a folder that exists.`,
      }
    case "launch-failed":
      return {
        kind,
        retriable: false,
        title: `${providerLabel} could not start`,
        guidance: `What it said is below. Check ${providerLabel} under Settings → Agents, and any settings or MCP configuration it reads, then send the message again.`,
      }
    case "launch-stalled":
      return {
        kind,
        retriable: true,
        title: `${providerLabel} stopped responding while starting`,
        guidance: "It went quiet before it was ready, which usually means an MCP server or a large session held it up. Your message is saved; send it again, and if this repeats check its MCP servers.",
      }
    case "unknown":
      return {
        kind,
        retriable: true,
        title: `${providerLabel} did not finish this turn`,
        guidance: `${providerLabel} ended the turn without saying why; what it did is in the conversation.`,
      }
  }
}

/** A preflight refusal retains the same secret-free verdict as a provider's terminal session event. */
export class ProviderFailureError extends Error {
  readonly failureEvidence: ProviderFailureEvidence

  constructor(message: string, failureEvidence: ProviderFailureEvidence, options?: ErrorOptions) {
    super(message, options)
    this.name = "ProviderFailureError"
    this.failureEvidence = failureEvidence
  }
}

/** Host preparation is the default at a mixed catch boundary. Native calls explicitly wrap their own failures. */
export function failureEvidenceOf({ error }: FailureBoundary): ProviderFailureEvidence {
  return error instanceof ProviderFailureError || error instanceof HostFailureError
    ? error.failureEvidence : { kind: "unknown", source: "host" }
}

export class HostFailureError extends Error {
  readonly failureEvidence: { kind: HostFailureKind; source: "host" }
  constructor(kind: HostFailureKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "HostFailureError"
    this.failureEvidence = { kind, source: "host" }
  }
}

/** Only called at the native provider call, never around Mako's preparation, history, tools or persistence. */
export async function providerCall<Value>(reply: Promise<Value>): Promise<Value> {
  try { return await reply }
  catch (error) {
    if (error instanceof HostFailureError || error instanceof ProviderFailureError) throw error
    const message = errorMessage({ error })
    throw new ProviderFailureError(message, providerTextEvidence(message), { cause: error })
  }
}
