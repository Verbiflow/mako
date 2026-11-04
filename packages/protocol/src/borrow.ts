import { z } from "zod"
import { ChunkHashSchema } from "./records.js"

/**
 * Borrowing: a Thread at one place needs something that lives at another. One contract for every kind of thing
 * (a file, a folder, variables, a credential, a command, a port) and every place (a Mac, a cloud machine, the
 * account's vault, a minting service). The person's yes is a Grant; each hand-over under it is a Lease; a borrower
 * states a Need. The broker (the account's, in the cloud; the device's own, for a borrower on the same device)
 * decides every lease by one pure function, `step`, and a device that is the source decides again for itself.
 *
 * Values never pass through the decision: the core sees kinds, refs, versions (a copy's SHA-256) and sizes. A copy's
 * bytes travel as the records' content-addressed chunks, sealed to `borrowSealContext`, and land at the borrower by
 * its materializer. Nothing the core answers, pushes or logs holds a value.
 *
 * The rules the core keeps, each a property test (`test/borrow.mjs`):
 * 1. Scope: a lease goes only to a borrower inside its grant's scope, for a resource its selector matches.
 * 2. Monotone revocation: after a revoke, no lease under the grant is issued or renewed, and every live one ends.
 * 3. Expiry: no lease outlives its grant.
 * 4. No value in the log: no event, refusal, push or listing holds a value's bytes.
 * 5. Source consent: a device-sourced lease is issued only after the device says yes, and the device may say no.
 * 6. Idempotence: the same need under the same correlation ID answers the same.
 * 7. Offline is typed: with the source unreachable, a stale lease on a held copy, or `source-offline`.
 */

export const BORROW_VERSION = 1

export const KINDS = ["file", "tree", "env", "credential", "command", "port"] as const
export const KindSchema = z.enum(KINDS)
export type Kind = z.infer<typeof KindSchema>

export const MODES = ["copy", "live", "minted", "proxy", "relay"] as const
export const ModeSchema = z.enum(MODES)
export type Mode = z.infer<typeof ModeSchema>

/** The modes each kind allows, in the order a new grant offers them. */
export const KIND_MODES = {
  file: ["copy", "live"],
  tree: ["copy", "live"],
  env: ["copy", "proxy"],
  credential: ["copy", "minted", "proxy"],
  command: ["relay"],
  port: ["relay"],
} as const satisfies Record<Kind, readonly Mode[]>

/** What a borrower may do with it: `write` sends a borrowed file's changes back to its source; `run` is for commands and ports. */
export const AccessSchema = z.enum(["read", "write", "run"])
export type Access = z.infer<typeof AccessSchema>
export const KIND_ACCESS = {
  file: ["read", "write"],
  tree: ["read", "write"],
  env: ["read"],
  credential: ["read"],
  command: ["run"],
  port: ["run"],
} as const satisfies Record<Kind, readonly Access[]>

/** Whether a kind can be borrowed in a mode, and given an access. */
export function allowsMode(kind: Kind, mode: Mode): boolean {
  const modes: readonly Mode[] = KIND_MODES[kind]
  return modes.includes(mode)
}
export function allowsAccess(kind: Kind, access: Access): boolean {
  const allowed: readonly Access[] = KIND_ACCESS[kind]
  return allowed.includes(access)
}

const Id = z.string().min(1).max(128)
const Ref = z.string().min(1).max(1024)
const Ms = z.number().int().nonnegative()

/** Who did something: the person (from a device of theirs), an agent's Thread, or Mako itself (an expiry, a Thread's end). */
export const ActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), account: Id, device: Id.optional() }).strict(),
  z.object({ kind: z.literal("thread"), account: Id, thread: Id }).strict(),
  z.object({ kind: z.literal("mako") }).strict(),
])
export type Actor = z.infer<typeof ActorSchema>

/** Where a borrower runs: one of the account's devices, or a cloud machine. */
export const PlaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device"), device: Id }).strict(),
  z.object({ kind: z.literal("machine"), machine: Id }).strict(),
])
export type Place = z.infer<typeof PlaceSchema>

/** A Thread at a place, as the account, its project (the repository it writes, `owner/name`) and its ID name it. */
export const BorrowerSchema = z.object({ account: Id, repository: Ref, thread: Id, place: PlaceSchema }).strict()
export type Borrower = z.infer<typeof BorrowerSchema>

/**
 * Who a grant reaches. The narrowest grant matching a need wins it: a Thread's over its project's, a project's over the
 * account's. Teams come later as one more level, between project and account.
 */
export const ScopeSchema = z.discriminatedUnion("level", [
  z.object({ level: z.literal("thread"), account: Id, thread: Id }).strict(),
  z.object({ level: z.literal("project"), account: Id, repository: Ref }).strict(),
  z.object({ level: z.literal("account"), account: Id }).strict(),
])
export type Scope = z.infer<typeof ScopeSchema>
const SCOPE_RANK = { thread: 0, project: 1, account: 2 } as const satisfies Record<Scope["level"], number>

/** Where a resource is: a device of the account's, the account's vault in the cloud, or a service that mints short-lived values. */
export const SourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device"), device: Id }).strict(),
  z.object({ kind: z.literal("vault") }).strict(),
  z.object({ kind: z.literal("mint"), service: Id }).strict(),
])
export type SourceRef = z.infer<typeof SourceRefSchema>

/**
 * Which resources a grant covers: a kind, and a ref or a pattern on refs. For `file` and `tree`, a path relative to the
 * checkout, or under the person's home as `~/…`, where `*` stays inside one folder and `**` crosses folders. For
 * `command`, an argv pattern of space-separated words, where `*` is one word and a final `**` the rest. For `env`,
 * `credential` and `port`, the name (`DATABASE_URL`, `github-app`, `db.internal:5432`), with `*` allowed.
 */
export const ResourceSelectorSchema = z.object({ kind: KindSchema, ref: Ref }).strict()
export type ResourceSelector = z.infer<typeof ResourceSelectorSchema>

export const LifetimeSchema = z.discriminatedUnion("until", [
  z.object({ until: z.literal("revoked") }).strict(),
  z.object({ until: z.literal("expires"), at: Ms }).strict(),
  z.object({ until: z.literal("thread-ends") }).strict(),
  z.object({ until: z.literal("once") }).strict(),
])
export type Lifetime = z.infer<typeof LifetimeSchema>

/** Whether the source's person is asked when a lease is taken. Only a device asks; the vault and a mint never do. */
export const AskSchema = z.enum(["never", "first-use", "each-use"])
export type Ask = z.infer<typeof AskSchema>

export const GrantSchema = z
  .object({
    id: Id,
    resource: ResourceSelectorSchema,
    source: SourceRefSchema,
    scope: ScopeSchema,
    mode: ModeSchema,
    access: AccessSchema,
    lifetime: LifetimeSchema,
    ask: AskSchema,
    /** Whether what it covers is a secret: a secret lands only in memory-backed files, never in a snapshot or a log. */
    secret: z.boolean(),
    /** Only for borrowers on the source device itself (a worktree reading its own Mac's main checkout), never another place. */
    within: z.literal("source-device").optional(),
    /** The name the person gave it or knows it by ("Cloudflare for parley"); the ref when absent. */
    label: z.string().max(200).optional(),
    grantedBy: ActorSchema,
    grantedAt: Ms,
    /** Moves with every change to the grant; a lease names the version it was decided under. */
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine((grant, context) => {
    if (!allowsMode(grant.resource.kind, grant.mode))
      context.addIssue({ code: "custom", message: `A ${grant.resource.kind} can't be borrowed as ${grant.mode}` })
    if (!allowsAccess(grant.resource.kind, grant.access))
      context.addIssue({ code: "custom", message: `A ${grant.resource.kind} can't be given ${grant.access} access` })
    if (grant.source.kind !== "device" && grant.ask !== "never")
      context.addIssue({ code: "custom", message: "Only a device asks its person; the vault and a mint are asked at the grant" })
    if (grant.mode === "minted" && grant.source.kind !== "mint" && grant.source.kind !== "vault")
      context.addIssue({ code: "custom", message: "Only a mint or the vault mints" })
    if (grant.mode === "relay" && grant.source.kind !== "device") context.addIssue({ code: "custom", message: "Only a device relays" })
    if (grant.lifetime.until === "thread-ends" && grant.scope.level !== "thread")
      context.addIssue({ code: "custom", message: "A grant that ends with its Thread is scoped to that Thread" })
    if (grant.within && grant.source.kind !== "device") context.addIssue({ code: "custom", message: "Only a device's grant keeps to the device" })
    if (grant.scope.account !== accountOf(grant.grantedBy, grant.scope.account))
      context.addIssue({ code: "custom", message: "A grant is given within its own account" })
  })
export type Grant = z.infer<typeof GrantSchema>

function accountOf(actor: Actor, fallback: string): string {
  return actor.kind === "mako" ? fallback : actor.account
}

/** A copy the borrower holds already: its version (the content's SHA-256) and when it took it. */
export const HoldingSchema = z.object({ version: ChunkHashSchema, at: Ms }).strict()
export type Holding = z.infer<typeof HoldingSchema>

/**
 * What a borrower asks for: one resource, exactly named, and why, in the agent's words (shown to the person when it
 * asks them). The correlation ID makes it one need however often it's sent.
 */
export const NeedSchema = z
  .object({
    kind: KindSchema,
    ref: Ref,
    for: BorrowerSchema,
    why: z.string().min(1).max(500),
    correlationId: Id,
    holding: HoldingSchema.optional(),
    /** The mode the borrower needs, when it needs one (a link where it would otherwise get a copy); a grant in another mode doesn't answer it. */
    mode: ModeSchema.optional(),
  })
  .strict()
export type Need = z.infer<typeof NeedSchema>

/** How a lease's value gets to the borrower: nothing to send (it holds this version, or the mode moves nothing), inline on the link, or as chunks. */
export const TransferSchema = z.enum(["none", "inline", "chunks"])
export type Transfer = z.infer<typeof TransferSchema>
/** The largest value sent inline on a link; larger ones go as sealed chunks of the records' store. */
export const BORROW_INLINE_BYTES = 64 * 1024
/** The largest copy a lease carries. */
export const BORROW_COPY_MAX_BYTES = 1024 * 1024 * 1024

export const DeliverySchema = z
  .object({
    transfer: TransferSchema,
    /** Lands only in memory-backed files at the borrower. */
    secret: z.boolean(),
    /** The copy's size, when it's a copy. */
    size: z.number().int().nonnegative().optional(),
  })
  .strict()
export type Delivery = z.infer<typeof DeliverySchema>

export const LeaseSchema = z
  .object({
    id: Id,
    grant: Id,
    grantVersion: z.number().int().positive(),
    borrower: BorrowerSchema,
    resource: ResourceSelectorSchema,
    source: SourceRefSchema,
    mode: ModeSchema,
    access: AccessSchema,
    /** The content's SHA-256 for copies; `g<grant version>` otherwise. */
    version: z.string().min(1).max(80),
    issuedAt: Ms,
    expiresAt: Ms,
    delivery: DeliverySchema,
    /** A copy served while its source is offline: how old it is, and when the source was last seen. */
    stale: z.object({ heldSince: Ms, sourceLastSeen: Ms }).strict().optional(),
  })
  .strict()
export type Lease = z.infer<typeof LeaseSchema>

/** What the person would be asked to grant, when nothing grants a need yet: it lands in Needs you and the Inbox. */
export const AskOfferSchema = z
  .object({
    resource: ResourceSelectorSchema,
    borrower: BorrowerSchema,
    why: z.string().max(500),
    /** The narrowest scope and the first mode the kind allows; the person may widen either. */
    scope: ScopeSchema,
    mode: ModeSchema,
  })
  .strict()
export type AskOffer = z.infer<typeof AskOfferSchema>

export const RefusalSchema = z.discriminatedUnion("refused", [
  z.object({ refused: z.literal("no-grant"), ask: AskOfferSchema }).strict(),
  z.object({ refused: z.literal("out-of-scope") }).strict(),
  z.object({ refused: z.literal("revoked") }).strict(),
  z.object({ refused: z.literal("expired") }).strict(),
  z
    .object({
      refused: z.literal("source-offline"),
      source: SourceRefSchema,
      lastSeen: Ms.nullable(),
      cached: HoldingSchema.optional(),
    })
    .strict(),
  z.object({ refused: z.literal("declined"), by: ActorSchema }).strict(),
  z.object({ refused: z.literal("too-large"), limit: z.number().int().positive() }).strict(),
  z.object({ refused: z.literal("unavailable"), detail: z.string().max(500) }).strict(),
])
export type Refusal = z.infer<typeof RefusalSchema>

/** A need its source is still deciding: the device was asked (`ask`); the answer is pushed, and the same need asked again answers it. */
export const PendingSchema = z.object({ pending: z.literal("source"), ask: Id, source: SourceRefSchema }).strict()
export type Pending = z.infer<typeof PendingSchema>

export const BorrowAnswerSchema = z.union([
  z.object({ lease: LeaseSchema }).strict(),
  z.object({ refusal: RefusalSchema }).strict(),
  PendingSchema,
])
export type BorrowAnswer = z.infer<typeof BorrowAnswerSchema>

export const LEASE_EVENT_KINDS = ["granted", "renewed", "refused", "revoked", "expired", "released", "asked"] as const
/**
 * One line of the lease log: who, what (the resource's name and version), from where, and why, never a value. The
 * same for every kind, in the cloud's log and a device's own.
 */
export const LeaseEventSchema = z
  .object({
    event: z.enum(LEASE_EVENT_KINDS),
    at: Ms,
    lease: Id.optional(),
    grant: Id.optional(),
    borrower: BorrowerSchema,
    resource: ResourceSelectorSchema,
    source: SourceRefSchema.optional(),
    version: z.string().max(80).optional(),
    refused: z.string().max(32).optional(),
    by: ActorSchema.optional(),
    correlationId: Id,
  })
  .strict()
export type LeaseEvent = z.infer<typeof LeaseEventSchema>

/**
 * What the broker pushes to a borrower on its link, as a `borrow` event: a lease decided after it waited on its source,
 * a lease ended (remove every materialization of it before acknowledging), or a newer version of a copy (refresh at the
 * next safe point: a turn's start, never mid-turn).
 */
export const BorrowPushSchema = z.discriminatedUnion("push", [
  z.object({ push: z.literal("decided"), correlationId: Id, answer: BorrowAnswerSchema }).strict(),
  z.object({ push: z.literal("ended"), lease: Id, why: z.enum(["revoked", "expired", "released"]) }).strict(),
  z.object({ push: z.literal("version"), lease: Id, version: z.string().max(80), grantVersion: z.number().int().positive() }).strict(),
])
export type BorrowPush = z.infer<typeof BorrowPushSchema>

/** What the broker asks a source device: may this borrower have this, and what version is it now. */
export const SourceAskSchema = z
  .object({
    ask: Id,
    grant: Id,
    resource: ResourceSelectorSchema,
    ref: Ref,
    mode: ModeSchema,
    borrower: BorrowerSchema,
    why: z.string().max(500),
    /** Whether the device asks its person (`first-use` not yet answered for this borrower, or `each-use`), or answers itself. */
    askPerson: z.boolean(),
  })
  .strict()
export type SourceAsk = z.infer<typeof SourceAskSchema>

export const SourceAnswerSchema = z.discriminatedUnion("answer", [
  z.object({ answer: z.literal("yes"), version: z.string().min(1).max(80), size: z.number().int().nonnegative().optional() }).strict(),
  z.object({ answer: z.literal("no"), by: ActorSchema }).strict(),
  z.object({ answer: z.literal("unavailable"), detail: z.string().max(500) }).strict(),
])
export type SourceAnswer = z.infer<typeof SourceAnswerSchema>

/**
 * What a borrower calls, wherever the broker is: the account's in the cloud, over the borrower's link, or the device's
 * own for a borrower on the same device. One call for every kind and mode.
 */
export interface Borrowing {
  borrow(need: Need): Promise<BorrowAnswer>
  renew(lease: string): Promise<BorrowAnswer>
  /** The borrower is done: the Thread ends, or a move leaves. */
  release(lease: string): Promise<void>
  /** The person's: every lease under the grant ends. */
  revoke(grant: string, by: Actor): Promise<void>
  /** The lease log as it's written, from `since` (ms) on. */
  events(since?: number): AsyncIterable<LeaseEvent>
}

/** The one seal over every borrowed value: the account, the grant and its version, so rotating re-seals by grant. */
export function borrowSealContext(account: string, grant: string, version: string): string {
  return `mako.borrow.v${BORROW_VERSION}\0${account}\0${grant}\0${version}`
}

/** Where the broker is reached. Values cross as sealed chunks through the records' `/chunks` routes of the borrower's link. */
export const BORROW_PATHS = {
  grants: "/v1/borrow/grants",
  needs: "/v1/borrow/needs",
  lease: (lease: string) => `/v1/borrow/leases/${encodeURIComponent(lease)}`,
  events: "/v1/borrow/events",
} as const

/** How long a lease lasts before it's renewed: a minted value an hour, anything else a day, never past its grant. */
export const LEASE_TTL_MS = {
  copy: 24 * 60 * 60_000,
  live: 24 * 60 * 60_000,
  minted: 60 * 60_000,
  proxy: 60 * 60_000,
  relay: 60 * 60_000,
} as const satisfies Record<Mode, number>

// ---- Matching ----

function escape(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

function pathPattern(pattern: string): RegExp {
  let source = ""
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at]!
    if (char === "*" && pattern[at + 1] === "*") {
      source += ".*"
      at++
    } else if (char === "*") source += "[^/]*"
    else if (char === "?") source += "[^/]"
    else source += escape(char)
  }
  return new RegExp(`^${source}$`)
}

function argvMatches(pattern: string, ref: string): boolean {
  const want = pattern.split(" ").filter(Boolean)
  const have = ref.split(" ").filter(Boolean)
  for (let at = 0; at < want.length; at++) {
    const word = want[at]!
    if (word === "**" && at === want.length - 1) return have.length >= at
    if (at >= have.length) return false
    if (word !== "*" && word !== have[at]) return false
  }
  return want.length === have.length
}

/** Whether a grant's selector covers a ref of a kind: a folder's covers the files in it too. A ref with `..` never matches a path pattern. */
export function selects(selector: ResourceSelector, kind: Kind, ref: string): boolean {
  const folderOfFile = selector.kind === "tree" && kind === "file"
  if (selector.kind !== kind && !folderOfFile) return false
  if (kind === "command") return argvMatches(selector.ref, ref)
  if ((kind === "file" || kind === "tree") && ref.split("/").includes("..")) return false
  if (selector.kind === "tree" && selector.ref === ref) return true
  if (selector.kind === "tree" && !/[*?]/.test(selector.ref)) return ref.startsWith(`${selector.ref}/`)
  return pathPattern(selector.ref).test(ref)
}

/** Whether a grant reaches a borrower: inside its scope, and on its source device when it keeps to it. */
export function reachesBorrower(grant: Grant, borrower: Borrower): boolean {
  if (!inScope(grant.scope, borrower)) return false
  if (!grant.within) return true
  return grant.source.kind === "device" && borrower.place.kind === "device" && borrower.place.device === grant.source.device
}

/** Whether a borrower is inside a scope. */
export function inScope(scope: Scope, borrower: Borrower): boolean {
  if (scope.account !== borrower.account) return false
  if (scope.level === "thread") return scope.thread === borrower.thread
  if (scope.level === "project") return scope.repository === borrower.repository
  return true
}

/** The time a grant lapses, when it has one. */
export function grantExpiry(grant: Grant): number | undefined {
  return grant.lifetime.until === "expires" ? grant.lifetime.at : undefined
}

// ---- The broker's pure core ----

export type GrantEnd = { at: number; why: "revoked" | "expired" | "spent" | "thread-ended"; by: Actor }
export type GrantState = { grant: Grant; ended?: GrantEnd; consented: string[] }
export type LeaseState = { lease: Lease; correlation: string; ended?: { at: number; why: "revoked" | "expired" | "released" } }
export type AskState = { ask: string; need: Need; grant: string; leaseId: string; at: number }
export type DeviceState = { online: boolean; lastSeen: number | null }

export type BrokerState = {
  account: string
  grants: Record<string, GrantState>
  leases: Record<string, LeaseState>
  /** Each need's answer, by its borrower's Thread and correlation ID. */
  answers: Record<string, BorrowAnswer>
  asks: Record<string, AskState>
  devices: Record<string, DeviceState>
}

export function emptyBroker(account: string): BrokerState {
  return { account, grants: {}, leases: {}, answers: {}, asks: {}, devices: {} }
}

/**
 * What the core is told. IDs a decision may need (`lease`, `ask`) are given by the caller, so a step is a pure
 * function of its state and input. `content` is what the vault says of the value a need names, when the source is
 * the vault: its version and size. A mint needs none; a device answers for itself.
 */
export type BrokerInput =
  | { type: "grant"; grant: Grant; at: number }
  | { type: "revoke"; grant: string; by: Actor; at: number }
  | { type: "borrow"; need: Need; at: number; lease: string; ask: string; content?: { version: string; size: number } }
  | { type: "source-answer"; ask: string; answer: SourceAnswer; at: number }
  | { type: "renew"; lease: string; at: number }
  | { type: "release"; lease: string; at: number }
  | { type: "thread-ended"; account: string; thread: string; at: number }
  | { type: "device"; device: string; online: boolean; at: number }
  | { type: "source-version"; grant: string; version: string; at: number }
  | { type: "tick"; at: number }

/** What a step asks its adapter to do: log, ask a device, push to a borrower, or let go of a sealed value no lease names. */
export type BrokerEffect =
  | { effect: "log"; event: LeaseEvent }
  | { effect: "ask"; device: string; ask: SourceAsk }
  | { effect: "push"; borrower: Borrower; push: BorrowPush }
  | { effect: "unreferenced"; grant: string; version: string }

export type BrokerResult = {
  state: BrokerState
  effects: BrokerEffect[]
  answer?: BorrowAnswer
  /** A refusal of the input itself: a stale grant version, a revoked grant given again, an unknown lease. */
  rejected?: string
}

function needKey(borrower: Borrower, correlationId: string): string {
  return `${borrower.account}\0${borrower.thread}\0${correlationId}`
}

function borrowerKey(borrower: Borrower): string {
  return `${borrower.account}\0${borrower.repository}\0${borrower.thread}`
}

function clone(state: BrokerState): BrokerState {
  return {
    account: state.account,
    grants: { ...state.grants },
    leases: { ...state.leases },
    answers: { ...state.answers },
    asks: { ...state.asks },
    devices: { ...state.devices },
  }
}

/** The grant that decides a need, by the narrowest scope and then the newest; or why none does. */
export function chooseGrant(state: BrokerState, need: Need, at: number): { grant: GrantState } | { refusal: Refusal } {
  const matching = Object.values(state.grants).filter((held) => selects(held.grant.resource, need.kind, need.ref) && (!need.mode || held.grant.mode === need.mode))
  const reaching = matching.filter((held) => reachesBorrower(held.grant, need.for))
  const standing = reaching.filter((held) => !held.ended && !lapsed(held.grant, at))
  if (standing.length) {
    standing.sort(
      (left, right) =>
        SCOPE_RANK[left.grant.scope.level] - SCOPE_RANK[right.grant.scope.level] || right.grant.grantedAt - left.grant.grantedAt || (left.grant.id < right.grant.id ? -1 : 1)
    )
    return { grant: standing[0]! }
  }
  if (reaching.length) {
    const last = reaching.reduce((newest, held) => (endedAt(held, at) > endedAt(newest, at) ? held : newest))
    const why = last.ended?.why ?? "expired"
    return { refusal: { refused: why === "revoked" || why === "thread-ended" || why === "spent" ? "revoked" : "expired" } }
  }
  if (matching.length) return { refusal: { refused: "out-of-scope" } }
  return { refusal: { refused: "no-grant", ask: askOffer(need) } }
}

function endedAt(held: GrantState, at: number): number {
  return held.ended?.at ?? grantExpiry(held.grant) ?? at
}

function lapsed(grant: Grant, at: number): boolean {
  const expiry = grantExpiry(grant)
  return expiry !== undefined && at >= expiry
}

function askOffer(need: Need): AskOffer {
  return {
    resource: { kind: need.kind, ref: need.ref },
    borrower: need.for,
    why: need.why,
    scope: { level: "thread", account: need.for.account, thread: need.for.thread },
    mode: need.mode ?? KIND_MODES[need.kind][0]!,
  }
}

function event(kind: LeaseEvent["event"], at: number, need: Pick<Need, "kind" | "ref" | "for" | "correlationId">, extra: Partial<LeaseEvent> = {}): BrokerEffect {
  return { effect: "log", event: { event: kind, at, borrower: need.for, resource: { kind: need.kind, ref: need.ref }, correlationId: need.correlationId, ...extra } }
}

function leaseEvent(kind: LeaseEvent["event"], at: number, held: LeaseState, extra: Partial<LeaseEvent> = {}): BrokerEffect {
  const { lease } = held
  return {
    effect: "log",
    event: { event: kind, at, lease: lease.id, grant: lease.grant, borrower: lease.borrower, resource: lease.resource, source: lease.source, version: lease.version, correlationId: held.correlation, ...extra },
  }
}

function expiresAt(grant: Grant, at: number): number {
  const ttl = at + LEASE_TTL_MS[grant.mode]
  const expiry = grantExpiry(grant)
  return expiry === undefined ? ttl : Math.min(ttl, expiry)
}

function delivery(grant: Grant, size: number | undefined, held: boolean): Delivery {
  const moves = grant.mode === "copy" || grant.mode === "minted"
  const transfer: Transfer = !moves || held ? "none" : grant.mode === "minted" || (size ?? 0) <= BORROW_INLINE_BYTES ? "inline" : "chunks"
  const landing: Delivery = { transfer, secret: grant.secret }
  if (size !== undefined) landing.size = size
  return landing
}

/** Ends a lease (revoked, expired, released), pushes it to its borrower, and lets go of its version when no live lease names it. */
function endLease(state: BrokerState, effects: BrokerEffect[], id: string, why: "revoked" | "expired" | "released", at: number, by?: Actor): void {
  const held = state.leases[id]
  if (!held || held.ended) return
  state.leases[id] = { ...held, ended: { at, why } }
  effects.push(leaseEvent(why, at, held, by ? { by } : {}))
  if (why !== "released") effects.push({ effect: "push", borrower: held.lease.borrower, push: { push: "ended", lease: id, why } })
  const { grant, version } = held.lease
  if (held.lease.mode === "copy" && !Object.values(state.leases).some((other) => !other.ended && other.lease.grant === grant && other.lease.version === version))
    effects.push({ effect: "unreferenced", grant, version })
}

function endGrant(state: BrokerState, effects: BrokerEffect[], id: string, end: GrantEnd): void {
  const held = state.grants[id]
  if (!held || (held.ended && held.ended.why !== "spent")) return
  state.grants[id] = { ...held, ended: end }
  const leaseWhy = end.why === "expired" ? "expired" : "revoked"
  for (const lease of Object.values(state.leases)) if (lease.lease.grant === id) endLease(state, effects, lease.lease.id, leaseWhy, end.at, end.by)
  for (const ask of Object.values(state.asks))
    if (ask.grant === id) {
      delete state.asks[ask.ask]
      decide(state, effects, ask.need, { refusal: { refused: leaseWhy } }, end.at)
    }
}

/** A lease, and the person's no, answer a need for good; any other refusal is decided afresh when it's asked again. */
function decide(state: BrokerState, effects: BrokerEffect[], need: Need, answer: BorrowAnswer, at: number, pushed = true): BorrowAnswer {
  const key = needKey(need.for, need.correlationId)
  if ("lease" in answer || ("refusal" in answer && answer.refusal.refused === "declined")) state.answers[key] = answer
  else delete state.answers[key]
  if ("refusal" in answer) effects.push(event("refused", at, need, { refused: answer.refusal.refused }))
  if (pushed) effects.push({ effect: "push", borrower: need.for, push: { push: "decided", correlationId: need.correlationId, answer } })
  return answer
}

function issue(state: BrokerState, effects: BrokerEffect[], need: Need, held: GrantState, id: string, version: string, size: number | undefined, at: number, stale?: Lease["stale"]): BorrowAnswer {
  const { grant } = held
  const lease: Lease = {
    id,
    grant: grant.id,
    grantVersion: grant.version,
    borrower: need.for,
    resource: { kind: need.kind, ref: need.ref },
    source: grant.source,
    mode: grant.mode,
    access: grant.access,
    version,
    issuedAt: at,
    expiresAt: expiresAt(grant, at),
    delivery: delivery(grant, size, need.holding?.version === version),
  }
  if (stale) lease.stale = stale
  state.leases[id] = { lease, correlation: need.correlationId }
  effects.push(leaseEvent("granted", at, state.leases[id]!))
  if (grant.lifetime.until === "once") endSpent(state, held, at)
  return { lease }
}

function endSpent(state: BrokerState, held: GrantState, at: number): void {
  state.grants[held.grant.id] = { ...held, consented: state.grants[held.grant.id]?.consented ?? held.consented, ended: { at, why: "spent", by: { kind: "mako" } } }
}

/** The broker's one decision function. It never throws on what a caller sends: an input it won't take comes back as `rejected`. */
export function step(previous: BrokerState, input: BrokerInput): BrokerResult {
  const state = clone(previous)
  const effects: BrokerEffect[] = []
  const done = (extra: Omit<BrokerResult, "state" | "effects"> = {}): BrokerResult => ({ state, effects, ...extra })
  expire(state, effects, input.at)
  switch (input.type) {
    case "grant": {
      const parsed = GrantSchema.safeParse(input.grant)
      if (!parsed.success) return done({ rejected: parsed.error.issues[0]?.message ?? "Not a grant" })
      const grant = parsed.data
      if (grant.scope.account !== state.account) return done({ rejected: "A grant of another account" })
      const known = state.grants[grant.id]
      if (known?.ended) return done({ rejected: "That grant has ended; a new grant takes a new ID" })
      if (known && grant.version <= known.grant.version) return done({ rejected: `Grant ${grant.id} is at version ${known.grant.version} already` })
      state.grants[grant.id] = { grant, consented: known && sameReach(known.grant, grant) ? known.consented : [] }
      if (known)
        for (const lease of Object.values(state.leases)) {
          if (lease.ended || lease.lease.grant !== grant.id) continue
          if (!reaches(known.grant, grant, { kind: lease.lease.resource.kind, ref: lease.lease.resource.ref, for: lease.lease.borrower })) {
            endLease(state, effects, lease.lease.id, "revoked", input.at, grant.grantedBy)
            continue
          }
          const expiry = grantExpiry(grant)
          const expires = expiry === undefined ? lease.lease.expiresAt : Math.min(lease.lease.expiresAt, expiry)
          state.leases[lease.lease.id] = { ...lease, lease: { ...lease.lease, grantVersion: grant.version, expiresAt: expires, delivery: { ...lease.lease.delivery, secret: grant.secret } } }
          if (lease.lease.mode !== "copy")
            effects.push({ effect: "push", borrower: lease.lease.borrower, push: { push: "version", lease: lease.lease.id, version: `g${grant.version}`, grantVersion: grant.version } })
        }
      if (known)
        for (const ask of Object.values(state.asks)) {
          if (ask.grant !== grant.id || reaches(known.grant, grant, ask.need)) continue
          delete state.asks[ask.ask]
          decide(state, effects, ask.need, { refusal: { refused: reachesBorrower(grant, ask.need.for) ? "revoked" : "out-of-scope" } }, input.at)
        }
      if (lapsed(grant, input.at)) endGrant(state, effects, grant.id, { at: input.at, why: "expired", by: { kind: "mako" } })
      return done()
    }
    case "revoke": {
      if (!state.grants[input.grant]) return done({ rejected: "No such grant" })
      endGrant(state, effects, input.grant, { at: input.at, why: "revoked", by: input.by })
      return done()
    }
    case "borrow": {
      const parsed = NeedSchema.safeParse(input.need)
      if (!parsed.success) return done({ rejected: parsed.error.issues[0]?.message ?? "Not a need" })
      const need = parsed.data
      if (need.for.account !== state.account) return done({ rejected: "A need of another account" })
      const answered = state.answers[needKey(need.for, need.correlationId)]
      if (answered && "lease" in answered) {
        const ended = state.leases[answered.lease.id]?.ended
        if (ended) return done({ answer: { refusal: { refused: ended.why === "expired" ? "expired" : "revoked" } } })
      }
      if (answered) return done({ answer: answered })
      const chosen = chooseGrant(state, need, input.at)
      if ("refusal" in chosen) return done({ answer: decide(state, effects, need, chosen, input.at, false) })
      const held = chosen.grant
      const { grant } = held
      if (grant.source.kind === "device") {
        const device = state.devices[grant.source.device]
        if (!device?.online) {
          const lastSeen = device?.lastSeen ?? null
          const consented = grant.ask === "never" || (grant.ask === "first-use" && held.consented.includes(borrowerKey(need.for)))
          if (grant.mode === "copy" && need.holding && consented)
            return done({ answer: decide(state, effects, need, issue(state, effects, need, held, input.lease, need.holding.version, undefined, input.at, { heldSince: need.holding.at, sourceLastSeen: lastSeen ?? 0 }), input.at, false) })
          return done({ answer: decide(state, effects, need, { refusal: offline(grant.source, lastSeen, need) }, input.at, false) })
        }
        const askPerson = grant.ask === "each-use" || (grant.ask === "first-use" && !held.consented.includes(borrowerKey(need.for)))
        const ask: SourceAsk = { ask: input.ask, grant: grant.id, resource: grant.resource, ref: need.ref, mode: grant.mode, borrower: need.for, why: need.why, askPerson }
        state.asks[input.ask] = { ask: input.ask, need, grant: grant.id, leaseId: input.lease, at: input.at }
        const pending: Pending = { pending: "source", ask: input.ask, source: grant.source }
        state.answers[needKey(need.for, need.correlationId)] = pending
        effects.push(event("asked", input.at, need, { grant: grant.id, source: grant.source }))
        effects.push({ effect: "ask", device: grant.source.device, ask })
        return done({ answer: pending })
      }
      if (grant.mode === "copy" && !input.content) return done({ answer: decide(state, effects, need, { refusal: { refused: "unavailable", detail: "The vault holds no value for it" } }, input.at, false) })
      if (input.content && input.content.size > BORROW_COPY_MAX_BYTES)
        return done({ answer: decide(state, effects, need, { refusal: { refused: "too-large", limit: BORROW_COPY_MAX_BYTES } }, input.at, false) })
      const version = grant.mode === "copy" ? input.content!.version : `g${grant.version}`
      return done({ answer: decide(state, effects, need, issue(state, effects, need, held, input.lease, version, input.content?.size, input.at), input.at, false) })
    }
    case "source-answer": {
      const asked = state.asks[input.ask]
      if (!asked) return done({ rejected: "No such ask, or it was answered" })
      delete state.asks[input.ask]
      const held = state.grants[asked.grant]
      const need = asked.need
      if (!held || held.ended || lapsed(held.grant, input.at)) {
        if (held && !held.ended) endGrant(state, effects, held.grant.id, { at: input.at, why: "expired", by: { kind: "mako" } })
        return done({ answer: decide(state, effects, need, { refusal: { refused: held?.ended?.why === "expired" || !held?.ended ? "expired" : "revoked" } }, input.at) })
      }
      const { answer } = input
      if (answer.answer === "no") return done({ answer: decide(state, effects, need, { refusal: { refused: "declined", by: answer.by } }, input.at) })
      if (answer.answer === "unavailable") return done({ answer: decide(state, effects, need, { refusal: { refused: "unavailable", detail: answer.detail } }, input.at) })
      if (answer.size !== undefined && answer.size > BORROW_COPY_MAX_BYTES)
        return done({ answer: decide(state, effects, need, { refusal: { refused: "too-large", limit: BORROW_COPY_MAX_BYTES } }, input.at) })
      const key = borrowerKey(need.for)
      const granted = state.grants[held.grant.id]!
      if (held.grant.ask === "first-use" && !granted.consented.includes(key)) state.grants[held.grant.id] = { ...granted, consented: [...granted.consented, key] }
      const version = held.grant.mode === "copy" ? answer.version : `g${held.grant.version}`
      return done({ answer: decide(state, effects, need, issue(state, effects, need, state.grants[held.grant.id]!, asked.leaseId, version, answer.size, input.at), input.at) })
    }
    case "renew": {
      const held = state.leases[input.lease]
      if (!held) return done({ rejected: "No such lease" })
      const now = state.leases[input.lease]!
      if (now.ended) return done({ answer: { refusal: { refused: now.ended.why === "expired" ? "expired" : "revoked" } } })
      const grant = state.grants[now.lease.grant]!
      if (grant.ended) return done({ answer: { refusal: { refused: grant.ended.why === "expired" ? "expired" : "revoked" } } })
      const lease: Lease = { ...now.lease, expiresAt: expiresAt(grant.grant, input.at), grantVersion: grant.grant.version }
      state.leases[input.lease] = { ...now, lease }
      effects.push(leaseEvent("renewed", input.at, state.leases[input.lease]!))
      return done({ answer: { lease } })
    }
    case "release": {
      if (!state.leases[input.lease]) return done({ rejected: "No such lease" })
      endLease(state, effects, input.lease, "released", input.at)
      return done()
    }
    case "thread-ended": {
      for (const held of Object.values(state.leases))
        if (held.lease.borrower.account === input.account && held.lease.borrower.thread === input.thread) endLease(state, effects, held.lease.id, "released", input.at)
      for (const held of Object.values(state.grants))
        if (held.grant.lifetime.until === "thread-ends" && held.grant.scope.level === "thread" && held.grant.scope.thread === input.thread)
          endGrant(state, effects, held.grant.id, { at: input.at, why: "thread-ended", by: { kind: "mako" } })
      return done()
    }
    case "device": {
      const known = state.devices[input.device]
      state.devices[input.device] = { online: input.online, lastSeen: input.online ? input.at : (known?.lastSeen ?? null) }
      if (!input.online)
        for (const ask of Object.values(state.asks)) {
          const grant = state.grants[ask.grant]?.grant
          if (grant?.source.kind !== "device" || grant.source.device !== input.device) continue
          delete state.asks[ask.ask]
          decide(state, effects, ask.need, { refusal: offline(grant.source, state.devices[input.device]!.lastSeen, ask.need) }, input.at)
        }
      return done()
    }
    case "source-version": {
      const held = state.grants[input.grant]
      if (!held || held.ended) return done({ rejected: "No such grant, or it has ended" })
      for (const lease of Object.values(state.leases))
        if (!lease.ended && lease.lease.grant === input.grant && lease.lease.mode === "copy" && lease.lease.version !== input.version)
          effects.push({ effect: "push", borrower: lease.lease.borrower, push: { push: "version", lease: lease.lease.id, version: input.version, grantVersion: held.grant.version } })
      return done()
    }
    case "tick":
      return done()
  }
}

/** Whether a changed grant still covers what its earlier version gave or was asked for. */
function reaches(before: Grant, after: Grant, need: Pick<Need, "kind" | "ref" | "for">): boolean {
  return sameReach(before, after) && before.within === after.within && reachesBorrower(after, need.for) && selects(after.resource, need.kind, need.ref)
}

function offline(source: SourceRef, lastSeen: number | null, need: Need): Refusal {
  const refusal: Extract<Refusal, { refused: "source-offline" }> = { refused: "source-offline", source, lastSeen }
  if (need.holding) refusal.cached = need.holding
  return refusal
}

function sameReach(left: Grant, right: Grant): boolean {
  return left.mode === right.mode && left.access === right.access && JSON.stringify(left.source) === JSON.stringify(right.source)
}

function expire(state: BrokerState, effects: BrokerEffect[], at: number): void {
  for (const held of Object.values(state.grants)) if (!held.ended && lapsed(held.grant, at)) endGrant(state, effects, held.grant.id, { at, why: "expired", by: { kind: "mako" } })
  for (const held of Object.values(state.leases)) if (!held.ended && at >= held.lease.expiresAt) endLease(state, effects, held.lease.id, "expired", at)
}

/** The live leases, as Settings and the Setup view list them: names, versions, expiries, never values. */
export function liveLeases(state: BrokerState, filter: { borrower?: Partial<Borrower>; grant?: string } = {}): Lease[] {
  return Object.values(state.leases)
    .filter((held) => !held.ended)
    .map((held) => held.lease)
    .filter((lease) => (filter.grant ? lease.grant === filter.grant : true))
    .filter((lease) => {
      const want = filter.borrower
      if (!want) return true
      return (!want.account || want.account === lease.borrower.account) && (!want.repository || want.repository === lease.borrower.repository) && (!want.thread || want.thread === lease.borrower.thread)
    })
    .sort((left, right) => left.issuedAt - right.issuedAt || (left.id < right.id ? -1 : 1))
}

/** The grants that stand, narrowest first. */
export function standingGrants(state: BrokerState, at: number): Grant[] {
  return Object.values(state.grants)
    .filter((held) => !held.ended && !lapsed(held.grant, at))
    .map((held) => held.grant)
    .sort((left, right) => SCOPE_RANK[left.scope.level] - SCOPE_RANK[right.scope.level] || left.grantedAt - right.grantedAt)
}
