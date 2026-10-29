import { z } from "zod"

/**
 * What tells the person a Session needs them, on every surface alike: the desktop's banners and in-app cards, the web
 * app's notifications on a phone or a computer, and the marks a list wears. One set of kinds, one rule for when a
 * Session's change is one of them, one key for each, and one wording, so no surface decides on its own what happened
 * or says it in its own words.
 *
 * - `needs-you`: it waits on the person for something other than an approval or a question (a terminal session's
 *   harness says it waits for input, a harness signed out mid-turn).
 * - `question`: the agent asked something.
 * - `approval`: a permission or a plan waits for a yes or a no. In Full access a harness asks for none; what's left is
 *   the questions an agent chooses to ask.
 * - `failed`: its turn ended in an error and Mako isn't continuing it itself.
 * - `finished`: its turn ended with an answer to read.
 *
 * Every kind comes from where a Session stands as its owner reports it (`thread-listing.ts`): its owner alone decides
 * that, and every device reads the same row.
 */
export const AttentionKindSchema = z.enum(["needs-you", "question", "approval", "failed", "finished"])
export type AttentionKind = z.infer<typeof AttentionKindSchema>

/** What a `waiting` Session waits on the person for: the kinds a Session asks with, as its owner says it. */
export const WaitingForSchema = z.enum(["needs-you", "question", "approval"])
export type WaitingFor = z.infer<typeof WaitingForSchema>

/** Whether a kind asks the person for something, so its notice is withdrawn once it's answered anywhere. */
export function asks(kind: AttentionKind): kind is WaitingFor {
  return kind === "needs-you" || kind === "question" || kind === "approval"
}

/** The longest line a notice or a list says of what a Session waits on. */
export const ATTENTION_LINE_CHARS = 200

const clipped = (text: string) => (text.length > ATTENTION_LINE_CHARS ? `${text.slice(0, ATTENTION_LINE_CHARS - 1)}…` : text)

/** What a Session waits on, as every surface says it: which kind of ask, and its line ("Approve: npm test"). */
export type Waiting = { for: WaitingFor; line: string }

/**
 * What a request the agent made of the person says: a question (one with questions, such as Claude Code's), or an
 * approval of the command or plan it names. `command` is how the owner writes a tool's title as its person would type it.
 */
export function requestWaiting(request: { title: string; questions?: readonly { question: string }[] | undefined }, command: (title: string) => string = (title) => title): Waiting {
  const question = request.questions?.[0]?.question
  if (question) return questionWaiting(question)
  return { for: "approval", line: clipped(`Approve: ${command(request.title)}`) }
}

/** An open question the agent asked, outside any approval. */
export function questionWaiting(question: string): Waiting {
  return { for: "question", line: clipped(`A question: ${question}`) }
}

/** A Session waiting on the person for anything else, in its harness's own words when it has some. */
export function needsYouWaiting(detail: string | undefined): Waiting {
  return { for: "needs-you", line: clipped(detail?.trim() || ATTENTION_WORDS["needs-you"].line) }
}

/**
 * The one wording. `did` follows the agent's name in a headline ("Codex needs your approval"); `line` is what a notice
 * says when nothing more specific is known ("Waiting for your approval").
 */
export const ATTENTION_WORDS = {
  "needs-you": { did: "needs you", line: "Waiting for you" },
  question: { did: "has a question", line: "Asking you a question" },
  approval: { did: "needs your approval", line: "Waiting for your approval" },
  failed: { did: "failed", line: "Its turn failed" },
  finished: { did: "finished", line: "Finished its turn" },
} as const satisfies Record<AttentionKind, { did: string; line: string }>

/** What happened, under the Thread's name: "Codex finished", or with no agent named, "Finished". */
export function attentionHeadline(kind: AttentionKind, agent?: string): string {
  const did = ATTENTION_WORDS[kind].did
  return agent ? `${agent} ${did}` : `${did.charAt(0).toUpperCase()}${did.slice(1)}`
}

/** What a notice says of it: its own detail (the reply, the question, the error), else the kind's line. */
export function attentionLine(kind: AttentionKind, detail?: string): string {
  return detail?.trim() || ATTENTION_WORDS[kind].line
}

/** From this many notices at once, they're one: "4 Threads need you" with their names. */
export const ATTENTION_SUMMARY_FROM = 3
/** How many names a summary lists before "and 2 more". */
const SUMMARY_NAMES = 4

/** What a notice says: a title, and a line or two under it. */
export type NoticeCopy = { title: string; body: string }

/** One notice for several: what they are, and which Threads, by name. */
export function attentionSummary(items: ReadonlyArray<{ kind: AttentionKind; title: string }>): NoticeCopy {
  const count = items.length
  const allFinished = items.every((item) => item.kind === "finished")
  const names = items.map((item) => item.title)
  const shown = names.slice(0, SUMMARY_NAMES)
  const rest = names.length - shown.length
  return {
    title: allFinished ? `${count} Threads finished` : `${count} Threads need you`,
    body: rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", "),
  }
}

/** A notice's subtitle and body as one, for a platform with no subtitle (a browser's, Windows', Linux's). */
export function foldedBody(notice: { subtitle?: string | undefined; body: string }): string {
  return notice.subtitle ? `${notice.subtitle}\n${notice.body}` : notice.body
}

/** What the rule reads of a Session's row (`ReportedSession`). */
export type AttentionRow = {
  state: "working" | "waiting" | "idle" | "failed" | "moving"
  waitingOn?: string | undefined
  waitingFor?: WaitingFor | undefined
  generation: number
  activityAt: string
}

/**
 * What a waiting row waits on the person for. An owner from before `waitingFor` said it only in `waitingOn`'s words,
 * which its own code wrote as "Approve: …" or "A question: …"; those are read for it, and anything else needs them.
 */
export function rowWaitingFor(row: Pick<AttentionRow, "waitingOn" | "waitingFor">): WaitingFor {
  if (row.waitingFor) return row.waitingFor
  if (row.waitingOn?.startsWith("A question: ")) return "question"
  if (row.waitingOn?.startsWith("Approve: ")) return "approval"
  return "needs-you"
}

/**
 * The key a fact is kept and said by, the same on every surface: the row's generation, where it stands, when it moved
 * and what it waits on. The same fact heard twice (a report again, a reconnect's whole list) has the same key.
 */
export function attentionKey(row: AttentionRow): string {
  return `${row.generation}:${row.state}:${row.activityAt}:${row.waitingFor ?? ""}:${row.waitingOn ?? ""}`
}

/** A fact a row's change said: its kind and key, and what of the row it stands on while it's true (`factStands`). */
export type AttentionFact = { kind: AttentionKind; key: string; generation: number; waitingOn?: string }

/**
 * The fact a row's change says, if any: the one rule every surface uses. A Session that starts waiting (or waits on
 * something new), fails, or comes to rest from work. A row first heard at rest says nothing; nor does a rename, a
 * move, or a report heard again.
 */
export function attentionFact(previous: AttentionRow | undefined, next: AttentionRow): AttentionFact | undefined {
  const fact = (kind: AttentionKind): AttentionFact => {
    const said: AttentionFact = { kind, key: attentionKey(next), generation: next.generation }
    if (asks(kind) && next.waitingOn !== undefined) said.waitingOn = next.waitingOn
    return said
  }
  if (next.state === "waiting") {
    const kind = rowWaitingFor(next)
    if (previous?.state !== "waiting" || previous.waitingOn !== next.waitingOn || rowWaitingFor(previous) !== kind) return fact(kind)
    return undefined
  }
  if (next.state === "failed" && previous?.state !== "failed") return fact("failed")
  if (next.state === "idle" && (previous?.state === "working" || previous?.state === "waiting")) return fact("finished")
  return undefined
}

/**
 * Whether a fact still stands of the row as it is now: a notice is sent and kept only while it does, and withdrawn from
 * every device once it doesn't. An ask stands while the Session waits on the same thing; a failure while it stays
 * failed; a finished turn while it stays at rest, so the person replying (from anywhere) takes it back, as a Thread
 * that starts again retires what it said on the desktop. A Session that changed hands, or left the list, says nothing.
 */
export function factStands(fact: AttentionFact, row: AttentionRow | undefined): boolean {
  if (!row || row.generation !== fact.generation) return false
  if (asks(fact.kind)) return row.state === "waiting" && rowWaitingFor(row) === fact.kind && row.waitingOn === fact.waitingOn
  return fact.kind === "failed" ? row.state === "failed" : row.state === "idle"
}

/** One notification per Thread on a device: a new fact about it replaces what it showed, and seeing it closes it. */
export function noticeTag(thread: string): string {
  return `thread:${thread}`
}

/** The tag of a notice that says several Threads at once. */
export const SUMMARY_TAG = "mako:summary"

const clipped200 = (text: string) => text.slice(0, 200)

/** A notice to show under its `tag`; a payload from before `type` is one. */
const NoticeShownSchema = z.object({
  type: z.literal("notice").default("notice"),
  kind: z.union([AttentionKindSchema, z.literal("summary")]),
  title: z.string().transform(clipped200),
  body: z.string().transform((text) => text.slice(0, 500)),
  tag: z.string().transform(clipped200),
  url: z.string(),
  at: z.number(),
})

/** Notices to take back: what a browser shows under `tags`, as the fact stopped standing or was seen elsewhere. */
const NoticeWithdrawnSchema = z.object({ type: z.literal("withdraw"), tags: z.array(z.string().transform(clipped200)).max(50), at: z.number() })

/**
 * What the account's Web Push carries to a browser, which its service worker shows (`readNotice`): a `notice`, shown
 * under its `tag`, or a `withdraw` of what it showed under `tags`.
 */
export const NoticePayloadSchema = z.union([NoticeWithdrawnSchema, NoticeShownSchema])
export type NoticePayload = z.output<typeof NoticePayloadSchema>

/** What a withdrawn notice says for the moment a browser shows it before it closes. */
export const WITHDRAWN = { title: "Mako", body: "Seen on another device" } as const

/** A push's payload as a service worker reads it, or nothing that's ours: malformed, or a notice whose tap would leave the app at `base`. */
export function readNotice(text: string | undefined, base: string): NoticePayload | undefined {
  if (!text) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const payload = NoticePayloadSchema.safeParse(value).data
  // A tap only ever opens the app itself.
  if (payload?.type === "notice" && !payload.url.startsWith(base)) return undefined
  return payload
}
