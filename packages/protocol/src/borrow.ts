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

export const KINDS = ["file", "tree", "env", "credential", "command", "port", "operation"] as const
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
  operation: ["relay"],
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
  operation: ["run"],
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
/**
 * What a device can serve, as it probed it: a name (`ios-simulator`, `xcode`, `android-emulator`, `gpu`, `cli`,
 * `reach`, `macos`), a version, and attributes (a simulator's runtime and device type, a CLI's command and the
 * profile it's signed in as). Never a value: a CLI's sign-in is the profile it answers as, never its token.
 */
const CapabilityName = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)
const Attribute = z.string().min(1).max(128)
export const CapabilitySchema = z
  .object({ capability: CapabilityName, version: z.string().min(1).max(64).optional(), attributes: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), Attribute).optional() })
  .strict()
export type Capability = z.infer<typeof CapabilitySchema>

/** What a need or grant requires of a device: a capability, and its version and attributes, each a value or a pattern with `*`. */
export const CapabilityQuerySchema = z
  .object({ capability: CapabilityName, version: z.string().min(1).max(64).optional(), where: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), Attribute).optional() })
  .strict()
export type CapabilityQuery = z.infer<typeof CapabilityQuerySchema>

/** A device's slots: what its own work holds (its Fins), out of what it runs at once. Borrowed operations take the rest. */
export const SlotsSchema = z.object({ used: z.number().int().nonnegative(), of: z.number().int().nonnegative() }).strict()
export type Slots = z.infer<typeof SlotsSchema>

export const SourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device"), device: Id }).strict(),
  z.object({ kind: z.literal("vault") }).strict(),
  z.object({ kind: z.literal("mint"), service: Id }).strict(),
  /** Whichever of the account's devices (or of those listed) advertise every requirement: the broker picks one. */
  z.object({ kind: z.literal("capable"), requires: z.array(CapabilityQuerySchema).min(1).max(8), devices: z.array(Id).max(32).optional() }).strict(),
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
    /**
     * The person's devices a borrower there may borrow under it. A borrower at a device is reached only by a grant
     * naming that device, or by one that keeps to it (`within`): nothing held on one device or in the account reaches
     * another of the person's devices unless the person said so for that device. The cloud's machines aren't devices;
     * this list doesn't touch them. Which Threads run on a device is the account's listing, checked by whatever serves
     * the device's credential before it asks the broker.
     */
    devices: z.array(Id).min(1).max(64).optional(),
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
    if (grant.source.kind !== "device" && grant.source.kind !== "capable" && grant.ask !== "never")
      context.addIssue({ code: "custom", message: "Only a device asks its person; the vault and a mint are asked at the grant" })
    if (grant.mode === "minted" && grant.source.kind !== "mint" && grant.source.kind !== "vault")
      context.addIssue({ code: "custom", message: "Only a mint or the vault mints" })
    if (grant.mode === "relay" && grant.source.kind !== "device" && grant.source.kind !== "capable") context.addIssue({ code: "custom", message: "Only a device relays" })
    if (grant.source.kind === "capable" && grant.mode !== "relay") context.addIssue({ code: "custom", message: "Capable devices only relay: the value stays where it runs" })
    if (grant.lifetime.until === "thread-ends" && grant.scope.level !== "thread")
      context.addIssue({ code: "custom", message: "A grant that ends with its Thread is scoped to that Thread" })
    if (grant.within && grant.source.kind !== "device") context.addIssue({ code: "custom", message: "Only a device's grant keeps to the device" })
    if (grant.within && grant.devices) context.addIssue({ code: "custom", message: "A grant that keeps to its device names no other devices" })
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
    /** What the device must have, beyond what the grant requires. */
    requires: z.array(CapabilityQuerySchema).max(8).optional(),
    /** How long it may wait for a capable device (ms since the epoch); 30 minutes when absent, never past 24 hours. */
    deadline: Ms.optional(),
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

/** What an operation's device says of its progress: a phase and how far, never its output's words. */
export const PROGRESS_PHASES = ["preparing", "booting", "building", "testing", "running", "uploading", "stopping"] as const
export const ProgressSchema = z.object({ phase: z.enum(PROGRESS_PHASES), percent: z.number().min(0).max(100).optional() }).strict()
export type Progress = z.infer<typeof ProgressSchema>

/** A stream a session serves its borrower alone (a simulator's screen as video, a build's log as text), by name. */
export const StreamSchema = z.object({ name: Id, kind: z.enum(["video", "text"]) }).strict()
export type Stream = z.infer<typeof StreamSchema>

/** A file name, never a path or contents: one segment, no slash, backslash or NUL, and not `.` or `..`. */
export const ArtifactNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^/\\\0]+$/)
  .refine((name) => name !== "." && name !== "..", "An artifact's name is a file's name")
/** A file a session made (a build, test results, a recording), as its lease lists it: by name, hash and size, never its contents. */
export const ArtifactSchema = z.object({ name: ArtifactNameSchema, hash: ChunkHashSchema, size: z.number().int().nonnegative() }).strict()
export type Artifact = z.infer<typeof ArtifactSchema>
/** The most streams and artifacts one session lists. */
export const SESSION_STREAMS_MAX = 8
export const SESSION_ARTIFACTS_MAX = 64

export const SessionSchema = z
  .object({
    state: z.enum(["starting", "running"]),
    heartbeatMs: z.number().int().positive(),
    lastBeat: Ms,
    progress: ProgressSchema.optional(),
    /** What it serves its borrower to watch, as its device said in a heartbeat. */
    streams: z.array(StreamSchema).max(SESSION_STREAMS_MAX).optional(),
    /** What it made, as its device gave each, while the lease lives: an ended lease lists none. */
    artifacts: z.array(ArtifactSchema).max(SESSION_ARTIFACTS_MAX).optional(),
  })
  .strict()
export type Session = z.infer<typeof SessionSchema>

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
    /** The device the broker chose, for a grant over capable devices. */
    device: Id.optional(),
    /** An operation's session: starting until its device says it runs, kept by heartbeats. */
    session: SessionSchema.optional(),
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

/**
 * Why a source or the vault couldn't give what a grant allows, as a fixed reason, never the source's own words: a
 * source's error text can hold anything, a value included, and a refusal is pushed, logged and shown.
 */
export const UNAVAILABLE_REASONS = ["not-found", "outside", "unreadable", "changed", "no-value", "error"] as const
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number]

/** Why a need waits for a capable device: none has the capability, none of those is online, or each has no slot free. */
export const WAIT_REASONS = ["none-capable", "no-device-online", "all-busy"] as const
export type WaitReason = (typeof WAIT_REASONS)[number]

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
  z.object({ refused: z.literal("unavailable"), reason: z.enum(UNAVAILABLE_REASONS) }).strict(),
  /** The borrower's Thread has ended: nothing more is lent to it. */
  z.object({ refused: z.literal("thread-ended") }).strict(),
  /** A need waited for a capable device until its deadline: how long, and why none could take it. */
  z.object({ refused: z.literal("no-capable-device"), why: z.enum(WAIT_REASONS), waited: Ms }).strict(),
])
export type Refusal = z.infer<typeof RefusalSchema>

/** A need its source is still deciding: the device was asked (`ask`); the answer is pushed, and the same need asked again answers it. */
export const PendingSchema = z.union([
  z.object({ pending: z.literal("source"), ask: Id, source: SourceRefSchema }).strict(),
  /** Waiting for a capable device with a slot: why, its place in line, since when, and until when. */
  z.object({ pending: z.literal("capacity"), why: z.enum(WAIT_REASONS), position: z.number().int().positive(), since: Ms, deadline: Ms }).strict(),
])
export type Pending = z.infer<typeof PendingSchema>

export const BorrowAnswerSchema = z.union([
  z.object({ lease: LeaseSchema }).strict(),
  z.object({ refusal: RefusalSchema }).strict(),
  PendingSchema,
])
export type BorrowAnswer = z.infer<typeof BorrowAnswerSchema>

export const LEASE_EVENT_KINDS = ["granted", "renewed", "refused", "revoked", "expired", "released", "asked", "queued", "cancelled", "lost"] as const
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
/** How a lease ends: revoked, lapsed, released by its borrower, cancelled (an operation stopped), or lost (its device stopped answering). */
export const LEASE_ENDS = ["revoked", "expired", "released", "cancelled", "lost"] as const
export type LeaseEnd = (typeof LEASE_ENDS)[number]

export const BorrowPushSchema = z.discriminatedUnion("push", [
  z.object({ push: z.literal("decided"), correlationId: Id, answer: BorrowAnswerSchema }).strict(),
  z.object({ push: z.literal("ended"), lease: Id, why: z.enum(LEASE_ENDS) }).strict(),
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
  z.object({ answer: z.literal("unavailable"), reason: z.enum(UNAVAILABLE_REASONS) }).strict(),
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
  if (grant.within) return grant.source.kind === "device" && borrower.place.kind === "device" && borrower.place.device === grant.source.device
  if (borrower.place.kind === "device") return grant.devices?.includes(borrower.place.device) ?? false
  return true
}

/** Whether a grant, as it stands, still decides a need: it reaches the borrower and selects what's asked, in its mode. */
function serves(grant: Grant, need: Need): boolean {
  return reachesBorrower(grant, need.for) && selects(grant.resource, need.kind, need.ref) && (!need.mode || grant.mode === need.mode)
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
export type LeaseState = { lease: Lease; correlation: string; ended?: { at: number; why: LeaseEnd } }
/** An ask out to a device; for a grant over capable devices, the device the broker chose, and those that already said they couldn't. */
export type AskState = { ask: string; need: Need; grant: string; leaseId: string; at: number; device?: string; excluded?: string[] }
/** A device as the broker last heard it: online, and for a device that advertises, what it can serve and its slots. */
export type DeviceState = { online: boolean; lastSeen: number | null; capabilities?: Capability[]; slots?: Slots }
/** A need waiting for a capable device: what and under which grant, the IDs it will be decided under, and its line. */
export type WaitState = { need: Need; grant: string; lease: string; ask: string; since: number; deadline: number; why: WaitReason; excluded?: string[] }

export type BrokerState = {
  account: string
  grants: Record<string, GrantState>
  leases: Record<string, LeaseState>
  /** Each need's answer, by the versioned whole-borrower/correlation tuple. */
  answers: Record<string, BorrowAnswer>
  asks: Record<string, AskState>
  devices: Record<string, DeviceState>
  /** The Threads that have ended, by account and Thread, with when: nothing is lent to them after. */
  endedThreads: Record<string, number>
  /** Needs waiting for a capable device, by the versioned whole-borrower/correlation tuple. */
  waiting: Record<string, WaitState>
}

export function emptyBroker(account: string): BrokerState {
  return { account, grants: {}, leases: {}, answers: {}, asks: {}, devices: {}, endedThreads: {}, waiting: {} }
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
  /** A device's capabilities and slots, as it probed them: it's online, and what it can serve is this. */
  | { type: "advertise"; device: string; capabilities: Capability[]; slots: Slots; at: number }
  /** From the lease's own device alone: it's alive, with the streams it serves when they changed. */
  | { type: "heartbeat"; lease: string; device: string; streams?: Stream[]; at: number }
  | { type: "progress"; lease: string; device: string; progress: Progress; at: number }
  /** The borrower's or the person's: the session stops. */
  | { type: "cancel"; lease: string; by: Actor; at: number }
  /** From the lease's own device alone, while it lives: a file the session made, its value kept sealed by the adapter. */
  | { type: "artifact"; lease: string; device: string; artifact: Artifact; at: number }

/** What a step asks its adapter to do: log, ask a device, push to a borrower, or let go of a sealed value no lease names. */
export type BrokerEffect =
  | { effect: "log"; event: LeaseEvent }
  | { effect: "ask"; device: string; ask: SourceAsk }
  | { effect: "push"; borrower: Borrower; push: BorrowPush }
  /** Tells the device serving a lease that it ended (every way it ends), so it stops what it runs and frees its slot. */
  | { effect: "tell"; device: string; push: Extract<BorrowPush, { push: "ended" }> }
  | { effect: "unreferenced"; grant: string; version: string }

export type BrokerResult = {
  state: BrokerState
  effects: BrokerEffect[]
  answer?: BorrowAnswer
  /** A refusal of the input itself: a stale grant version, a revoked grant given again, an unknown lease. */
  rejected?: string
}

/**
 * A need's key: its whole borrower (account, repository, Thread and place) and its correlation ID. The same Thread asking
 * from another repository or place is another borrower, decided afresh, never handed the first one's answer.
 */
export function needKey(borrower: Borrower, correlationId: string): string {
  const placeId = borrower.place.kind === "device" ? borrower.place.device : borrower.place.machine
  return `borrow-need:v2:${JSON.stringify([borrower.account, borrower.repository, borrower.thread, borrower.place.kind, placeId, correlationId])}`
}

/** Old keys always contain literal NUL separators; never split or interpret them as a borrower. */
function currentNeedKey(key: string): boolean {
  return key.startsWith("borrow-need:v2:") && !key.includes("\0")
}

function borrowerKey(borrower: Borrower): string {
  return `${borrower.account}\0${borrower.repository}\0${borrower.thread}`
}

/**
 * Keep current answers, recover old lease answers only from their structured lease/correlation, and rebuild pending
 * work from its validated Need. Unattributed old refusals miss once. No legacy key is decoded. Canonical work wins
 * a duplicate from an old writer; leases and the winning ask/wait's IDs and queue times are never rewritten.
 * An old binary can still make its own ambiguous lookup: this reader does not make rollback to it safe.
 */
function clone(state: BrokerState): BrokerState {
  const answers: BrokerState["answers"] = {}
  const leaseAnswer = (answer: BorrowAnswer) => {
    if (!("lease" in answer)) return undefined
    const held = state.leases[answer.lease.id]
    const lease = LeaseSchema.safeParse(held?.lease)
    const correlation = Id.safeParse(held?.correlation)
    if (!lease.success || !correlation.success || lease.data.borrower.account !== state.account) return undefined
    return { key: needKey(lease.data.borrower, correlation.data), answer: { lease: lease.data } }
  }
  for (const [key, answer] of Object.entries(state.answers)) {
    if (!currentNeedKey(key)) continue
    const recovered = leaseAnswer(answer)
    if (recovered?.key === key) answers[key] = recovered.answer
    else if ("refusal" in answer && answer.refusal.refused === "declined") answers[key] = answer
    // A pending answer is valid only while its retained ask below still exists.
  }
  const pending = Object.entries(state.asks).flatMap(([id, ask]) => {
    const need = NeedSchema.safeParse(ask.need)
    if (!need.success || need.data.for.account !== state.account || ask.ask !== id) return []
    const key = needKey(need.data.for, need.data.correlationId)
    const known = state.answers[key]
    const preferred = known && "pending" in known && known.pending === "source" && known.ask === id ? 0 : 1
    return [{ id, ask: { ...ask, need: need.data }, key, preferred }]
  }).sort((a, b) => a.preferred - b.preferred || a.ask.at - b.ask.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const currentPendingKeys = new Set(pending.filter((item) => item.preferred === 0).map((item) => item.key))
  for (const [key, answer] of Object.entries(state.answers)) {
    if (currentNeedKey(key)) continue
    const recovered = leaseAnswer(answer)
    if (recovered && !currentPendingKeys.has(recovered.key) && !state.waiting[recovered.key] && !answers[recovered.key]) answers[recovered.key] = recovered.answer
  }

  const asks: BrokerState["asks"] = {}

  for (const { id, ask, key } of pending) {
    const current = state.answers[key]
    const canonicalPending = current && "pending" in current && current.pending === "source" && current.ask === id
    if (answers[key] || (state.waiting[key] && !canonicalPending)) continue
    const source = state.grants[ask.grant]?.grant.source
    const device = source?.kind === "device" ? source.device : source?.kind === "capable" ? ask.device : undefined
    if (!device) continue
    asks[id] = ask
    answers[key] = { pending: "source", ask: id, source: { kind: "device", device } }
  }

  const waiting: BrokerState["waiting"] = {}
  const line = Object.entries(state.waiting).flatMap(([oldKey, wait]) => {
    const need = NeedSchema.safeParse(wait.need)
    if (!need.success || need.data.for.account !== state.account) return []
    const key = needKey(need.data.for, need.data.correlationId)
    return [{ wait: { ...wait, need: need.data }, key, preferred: oldKey === key ? 0 : 1 }]
  }).sort((a, b) => a.preferred - b.preferred || a.wait.since - b.wait.since || (a.wait.ask < b.wait.ask ? -1 : a.wait.ask > b.wait.ask ? 1 : 0))
  for (const { wait, key } of line) if (!answers[key] && !waiting[key]) waiting[key] = wait

  return {
    account: state.account,
    grants: { ...state.grants },
    leases: { ...state.leases },
    answers,
    asks,
    devices: { ...state.devices },
    endedThreads: { ...state.endedThreads },
    waiting,
  }
}

function threadKey(account: string, thread: string): string {
  return `${account}\0${thread}`
}

/**
 * How long an ended lease and the answers naming it are kept before they're let go, so a broker's state stays the
 * size of what's live: a replayed need older than this is decided afresh. The log keeps the history. An ended Thread
 * is never let go: ending is terminal, and its mark (one key and a time) is all a broker keeps of it.
 */
export const RETIRE_MS = 7 * 24 * 60 * 60_000

function retire(state: BrokerState, at: number): void {
  for (const [id, held] of Object.entries(state.leases)) if (held.ended && at - held.ended.at >= RETIRE_MS) delete state.leases[id]
  for (const [key, answer] of Object.entries(state.answers)) if ("lease" in answer && !state.leases[answer.lease.id]) delete state.answers[key]
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
function endLease(state: BrokerState, effects: BrokerEffect[], id: string, why: LeaseEnd, at: number, by?: Actor): void {
  const held = state.leases[id]
  if (!held || held.ended) return
  state.leases[id] = { ...held, ended: { at, why } }
  effects.push(leaseEvent(why, at, held, by ? { by } : {}))
  if (why !== "released") effects.push({ effect: "push", borrower: held.lease.borrower, push: { push: "ended", lease: id, why } })
  if (held.lease.device) effects.push({ effect: "tell", device: held.lease.device, push: { push: "ended", lease: id, why } })
  // A session's files go with it: listed only while it lives, and let go once no live lease of its grant names them.
  // Files are kept by grant and hash, so two sessions that made the same bytes share one, kept for the last of them.
  const session = held.lease.session
  if (session?.artifacts?.length) {
    const { artifacts, ...kept } = session
    state.leases[id] = { ...state.leases[id]!, lease: { ...held.lease, session: kept } }
    const named = (hash: string) =>
      Object.values(state.leases).some((other) => !other.ended && other.lease.grant === held.lease.grant && other.lease.session?.artifacts?.some((each) => each.hash === hash))
    for (const artifact of artifacts) if (!named(artifact.hash)) effects.push({ effect: "unreferenced", grant: held.lease.grant, version: artifact.hash })
  }
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
  for (const [key, wait] of Object.entries(state.waiting))
    if (wait.grant === id) {
      delete state.waiting[key]
      decide(state, effects, wait.need, { refusal: { refused: leaseWhy } }, end.at)
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

function issue(state: BrokerState, effects: BrokerEffect[], need: Need, held: GrantState, id: string, version: string, size: number | undefined, at: number, stale?: Lease["stale"], device?: string): BorrowAnswer {
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
  if (device) lease.device = device
  if (need.kind === "operation") lease.session = { state: "starting", heartbeatMs: SESSION_HEARTBEAT_MS, lastBeat: at }
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
  const done = (extra: Omit<BrokerResult, "state" | "effects"> = {}): BrokerResult => {
    wake(state, effects, input.at)
    if (extra.answer && "pending" in extra.answer && extra.answer.pending === "capacity" && input.type === "borrow") {
      const key = needKey(input.need.for, input.need.correlationId)
      extra.answer = state.waiting[key] ? waitingAnswer(state, key) : (state.answers[key] ?? extra.answer)
    }
    return { state, effects, ...extra }
  }
  expire(state, effects, input.at)
  retire(state, input.at)
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
      if (known)
        for (const [key, wait] of Object.entries(state.waiting)) {
          if (wait.grant !== grant.id || serves(grant, wait.need)) continue
          delete state.waiting[key]
          decide(state, effects, wait.need, { refusal: { refused: reachesBorrower(grant, wait.need.for) ? "revoked" : "out-of-scope" } }, input.at)
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
      if (state.endedThreads[threadKey(need.for.account, need.for.thread)] !== undefined) return done({ answer: decide(state, effects, need, { refusal: { refused: "thread-ended" } }, input.at, false) })
      const answered = state.answers[needKey(need.for, need.correlationId)]
      if (answered && "lease" in answered) {
        const ended = state.leases[answered.lease.id]?.ended
        if (ended) return done({ answer: { refusal: { refused: ended.why === "expired" ? "expired" : "revoked" } } })
      }
      if (answered) return done({ answer: answered })
      const waitingKey = needKey(need.for, need.correlationId)
      if (state.waiting[waitingKey]) return done({ answer: waitingAnswer(state, waitingKey) })
      const chosen = chooseGrant(state, need, input.at)
      if ("refusal" in chosen) return done({ answer: decide(state, effects, need, chosen, input.at, false) })
      const held = chosen.grant
      const { grant } = held
      if (grant.source.kind === "capable") return done({ answer: routeOrWait(state, effects, need, held, input.lease, input.ask, input.at, [], input.at) })
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
        state.asks[input.ask] = { ask: input.ask, need, grant: grant.id, leaseId: input.lease, at: input.at, device: grant.source.device }
        const pending: Pending = { pending: "source", ask: input.ask, source: grant.source }
        state.answers[needKey(need.for, need.correlationId)] = pending
        effects.push(event("asked", input.at, need, { grant: grant.id, source: grant.source }))
        effects.push({ effect: "ask", device: grant.source.device, ask })
        return done({ answer: pending })
      }
      if (grant.mode === "copy" && !input.content) return done({ answer: decide(state, effects, need, { refusal: { refused: "unavailable", reason: "no-value" } }, input.at, false) })
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
      if (state.endedThreads[threadKey(need.for.account, need.for.thread)] !== undefined) return done({ answer: decide(state, effects, need, { refusal: { refused: "thread-ended" } }, input.at) })
      if (!held || held.ended || lapsed(held.grant, input.at)) {
        if (held && !held.ended) endGrant(state, effects, held.grant.id, { at: input.at, why: "expired", by: { kind: "mako" } })
        return done({ answer: decide(state, effects, need, { refusal: { refused: held?.ended?.why === "expired" || !held?.ended ? "expired" : "revoked" } }, input.at) })
      }
      const { answer } = input
      if (answer.answer === "no") return done({ answer: decide(state, effects, need, { refusal: { refused: "declined", by: answer.by } }, input.at) })
      if (answer.answer === "unavailable" && held.grant.source.kind === "capable" && asked.device) {
        const excluded = [...(asked.excluded ?? []), asked.device]
        return done({ answer: routeOrWait(state, effects, need, held, asked.leaseId, asked.ask, asked.at, excluded, input.at) })
      }
      if (answer.answer === "unavailable") return done({ answer: decide(state, effects, need, { refusal: { refused: "unavailable", reason: answer.reason } }, input.at) })
      if (answer.size !== undefined && answer.size > BORROW_COPY_MAX_BYTES)
        return done({ answer: decide(state, effects, need, { refusal: { refused: "too-large", limit: BORROW_COPY_MAX_BYTES } }, input.at) })
      const key = borrowerKey(need.for)
      const granted = state.grants[held.grant.id]!
      if (held.grant.ask === "first-use" && !granted.consented.includes(key)) state.grants[held.grant.id] = { ...granted, consented: [...granted.consented, key] }
      const version = held.grant.mode === "copy" ? answer.version : `g${held.grant.version}`
      const device = held.grant.source.kind === "capable" ? asked.device : undefined
      return done({ answer: decide(state, effects, need, issue(state, effects, need, state.grants[held.grant.id]!, asked.leaseId, version, answer.size, input.at, undefined, device), input.at) })
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
      state.endedThreads[threadKey(input.account, input.thread)] = input.at
      for (const [key, wait] of Object.entries(state.waiting))
        if (wait.need.for.account === input.account && wait.need.for.thread === input.thread) {
          delete state.waiting[key]
          decide(state, effects, wait.need, { refusal: { refused: "thread-ended" } }, input.at)
        }
      for (const ask of Object.values(state.asks))
        if (ask.need.for.account === input.account && ask.need.for.thread === input.thread) {
          delete state.asks[ask.ask]
          decide(state, effects, ask.need, { refusal: { refused: "thread-ended" } }, input.at)
        }
      for (const held of Object.values(state.leases))
        if (held.lease.borrower.account === input.account && held.lease.borrower.thread === input.thread) endLease(state, effects, held.lease.id, "released", input.at)
      for (const held of Object.values(state.grants))
        if (held.grant.lifetime.until === "thread-ends" && held.grant.scope.level === "thread" && held.grant.scope.thread === input.thread)
          endGrant(state, effects, held.grant.id, { at: input.at, why: "thread-ended", by: { kind: "mako" } })
      return done()
    }
    case "device": {
      const known = state.devices[input.device]
      const seen: DeviceState = { ...known, online: input.online, lastSeen: input.online ? input.at : (known?.lastSeen ?? null) }
      state.devices[input.device] = seen
      if (!input.online) {
        for (const ask of Object.values(state.asks)) {
          const held = state.grants[ask.grant]
          if (!held || ask.device !== input.device) continue
          delete state.asks[ask.ask]
          if (held.grant.source.kind === "capable") routeOrWait(state, effects, ask.need, held, ask.leaseId, ask.ask, ask.at, ask.excluded ?? [], input.at)
          else if (held.grant.source.kind === "device") decide(state, effects, ask.need, { refusal: offline(held.grant.source, seen.lastSeen, ask.need) }, input.at)
        }
        for (const held of Object.values(state.leases)) if (!held.ended && held.lease.session && held.lease.device === input.device) endLease(state, effects, held.lease.id, "lost", input.at)
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
    case "advertise": {
      const capabilities = z.array(CapabilitySchema).max(64).safeParse(input.capabilities)
      const slots = SlotsSchema.safeParse(input.slots)
      if (!capabilities.success || !slots.success) return done({ rejected: "Not an advertisement" })
      state.devices[input.device] = { online: true, lastSeen: input.at, capabilities: capabilities.data, slots: slots.data }
      return done()
    }
    case "heartbeat":
    case "progress": {
      const held = state.leases[input.lease]
      if (!held || held.ended || !held.lease.session) return done({ rejected: "No such live session" })
      if (held.lease.device !== input.device) return done({ rejected: "Only the lease's device speaks for its session" })
      const session: Session = { ...held.lease.session, state: "running", lastBeat: input.at }
      if (input.type === "progress") {
        const progress = ProgressSchema.safeParse(input.progress)
        if (!progress.success) return done({ rejected: "Not a progress" })
        session.progress = progress.data
      } else if (input.streams) {
        const streams = z.array(StreamSchema).max(SESSION_STREAMS_MAX).safeParse(input.streams)
        if (!streams.success) return done({ rejected: "Not a session's streams" })
        session.streams = streams.data
      }
      state.leases[input.lease] = { ...held, lease: { ...held.lease, session } }
      return done()
    }
    case "artifact": {
      const held = state.leases[input.lease]
      if (!held || held.ended || !held.lease.session) return done({ rejected: "No such live session" })
      if (held.lease.device !== input.device) return done({ rejected: "Only the lease's device gives its session files" })
      const artifact = ArtifactSchema.safeParse(input.artifact)
      if (!artifact.success) return done({ rejected: artifact.error.issues[0]?.message ?? "Not an artifact" })
      const listed = (held.lease.session.artifacts ?? []).filter((each) => each.hash !== artifact.data.hash)
      if (listed.length >= SESSION_ARTIFACTS_MAX) return done({ rejected: `A session lists at most ${SESSION_ARTIFACTS_MAX} files` })
      state.leases[input.lease] = { ...held, lease: { ...held.lease, session: { ...held.lease.session, artifacts: [...listed, artifact.data] } } }
      return done()
    }
    case "cancel": {
      const held = state.leases[input.lease]
      if (!held) return done({ rejected: "No such lease" })
      endLease(state, effects, input.lease, "cancelled", input.at, input.by)
      return done()
    }
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
  for (const held of Object.values(state.leases))
    if (!held.ended && held.lease.session && at - held.lease.session.lastBeat > SESSION_LOST_BEATS * held.lease.session.heartbeatMs) endLease(state, effects, held.lease.id, "lost", at)
}

// ---- Capable devices: routing, waiting and waking ----

/** How long a need waits for a capable device unless it says, and the most it may. */
export const WAIT_DEFAULT_MS = 30 * 60_000
export const WAIT_MAX_MS = 24 * 60 * 60_000
/** How often an operation's device says it's alive, and how many beats it may miss before its session is lost. */
export const SESSION_HEARTBEAT_MS = 60_000
export const SESSION_LOST_BEATS = 3

function glob(pattern: string, value: string): boolean {
  return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join(".*")}$`).test(value)
}

/** Whether a device's capabilities satisfy every requirement. */
export function satisfies(capabilities: readonly Capability[], requires: readonly CapabilityQuery[]): boolean {
  return requires.every((query) =>
    capabilities.some(
      (capability) =>
        capability.capability === query.capability &&
        (query.version === undefined || (capability.version !== undefined && glob(query.version, capability.version))) &&
        Object.entries(query.where ?? {}).every(([key, want]) => capability.attributes?.[key] !== undefined && glob(want, capability.attributes[key]!))
    )
  )
}

/** Slots a device has free: what it advertised less its own work, less the sessions and asks the broker has on it. */
export function freeSlots(state: BrokerState, device: string): number {
  const known = state.devices[device]
  if (!known?.slots) return 0
  const leased = Object.values(state.leases).filter((held) => !held.ended && held.lease.device === device).length
  const asked = Object.values(state.asks).filter((ask) => ask.device === device && state.grants[ask.grant]?.grant.source.kind === "capable").length
  return known.slots.of - known.slots.used - leased - asked
}

/**
 * The device a need under a grant over capable devices goes to, by one rule: allowed (the grant's devices), able
 * (it advertises every requirement), available (online, a slot free); then the borrower's own device, one already
 * serving this borrower, the most slots free, and the lowest ID. Or why none.
 */
export function route(state: BrokerState, grant: Grant, need: Need, excluded: readonly string[] = []): { device: string } | { why: WaitReason } {
  if (grant.source.kind !== "capable") return { why: "none-capable" }
  const source = grant.source
  const requires = [...source.requires, ...(need.requires ?? [])]
  const able = Object.entries(state.devices).filter(
    ([id, known]) => (!source.devices || source.devices.includes(id)) && !excluded.includes(id) && satisfies(known.capabilities ?? [], requires)
  )
  if (!able.length) return { why: "none-capable" }
  const online = able.filter(([, known]) => known.online)
  if (!online.length) return { why: "no-device-online" }
  const free = online.filter(([id]) => freeSlots(state, id) > 0)
  if (!free.length) return { why: "all-busy" }
  const own = need.for.place.kind === "device" ? need.for.place.device : undefined
  const warm = (id: string) => Object.values(state.leases).some((held) => !held.ended && held.lease.device === id && held.lease.borrower.thread === need.for.thread)
  free.sort(([left], [right]) => Number(right === own) - Number(left === own) || Number(warm(right)) - Number(warm(left)) || freeSlots(state, right) - freeSlots(state, left) || (left < right ? -1 : 1))
  return { device: free[0]![0] }
}

function askCapable(state: BrokerState, effects: BrokerEffect[], need: Need, held: GrantState, device: string, leaseId: string, askId: string, at: number, excluded: readonly string[]): Pending {
  const { grant } = held
  const askPerson = grant.ask === "each-use" || (grant.ask === "first-use" && !held.consented.includes(borrowerKey(need.for)))
  const ask: SourceAsk = { ask: askId, grant: grant.id, resource: grant.resource, ref: need.ref, mode: grant.mode, borrower: need.for, why: need.why, askPerson }
  const asked: AskState = { ask: askId, need, grant: grant.id, leaseId, at, device }
  if (excluded.length) asked.excluded = [...excluded]
  state.asks[askId] = asked
  const pending: Pending = { pending: "source", ask: askId, source: { kind: "device", device } }
  state.answers[needKey(need.for, need.correlationId)] = pending
  effects.push(event("asked", at, need, { grant: grant.id, source: { kind: "device", device } }))
  effects.push({ effect: "ask", device, ask })
  return pending
}

/** Routes a need to a capable device and asks it, or puts it in line. */
function routeOrWait(state: BrokerState, effects: BrokerEffect[], need: Need, held: GrantState, leaseId: string, askId: string, since: number, excluded: readonly string[], at: number): BorrowAnswer {
  const routed = route(state, held.grant, need, excluded)
  if ("device" in routed) return askCapable(state, effects, need, held, routed.device, leaseId, askId, at, excluded)
  const key = needKey(need.for, need.correlationId)
  delete state.answers[key]
  const wanted = need.deadline ?? since + WAIT_DEFAULT_MS
  const wait: WaitState = { need, grant: held.grant.id, lease: leaseId, ask: askId, since, deadline: Math.min(Math.max(wanted, at), since + WAIT_MAX_MS), why: routed.why }
  if (excluded.length) wait.excluded = [...excluded]
  const known = state.waiting[key]
  state.waiting[key] = wait
  if (!known) effects.push(event("queued", at, need, { grant: held.grant.id }))
  return waitingAnswer(state, key)
}

function waitingAnswer(state: BrokerState, key: string): Pending {
  const wait = state.waiting[key]!
  const ahead = Object.values(state.waiting).filter((other) => other.grant === wait.grant && (other.since < wait.since || (other.since === wait.since && other.ask < wait.ask))).length
  return { pending: "capacity", why: wait.why, position: ahead + 1, since: wait.since, deadline: wait.deadline }
}

/** Every waiting need, oldest first: ended with its deadline, or routed the moment a capable device has room. */
function wake(state: BrokerState, effects: BrokerEffect[], at: number): void {
  const line = Object.entries(state.waiting).sort(([, left], [, right]) => left.since - right.since || (left.ask < right.ask ? -1 : 1))
  for (const [key, wait] of line) {
    const held = state.grants[wait.grant]
    if (!held || held.ended || lapsed(held.grant, at)) {
      delete state.waiting[key]
      decide(state, effects, wait.need, { refusal: { refused: held?.ended?.why === "revoked" ? "revoked" : "expired" } }, at)
      continue
    }
    // Past its deadline a need is refused, whatever room has come: never served late.
    if (at >= wait.deadline) {
      delete state.waiting[key]
      decide(state, effects, wait.need, { refusal: { refused: "no-capable-device", why: wait.why, waited: at - wait.since } }, at)
      continue
    }
    // Issued only under the grant as it stands now: one changed since the need queued may no longer reach it.
    if (!serves(held.grant, wait.need)) {
      delete state.waiting[key]
      decide(state, effects, wait.need, { refusal: { refused: reachesBorrower(held.grant, wait.need.for) ? "revoked" : "out-of-scope" } }, at)
      continue
    }
    const routed = route(state, held.grant, wait.need, wait.excluded ?? [])
    if ("device" in routed) {
      delete state.waiting[key]
      askCapable(state, effects, wait.need, held, routed.device, wait.lease, wait.ask, at, wait.excluded ?? [])
      continue
    }
    if (routed.why !== wait.why) state.waiting[key] = { ...wait, why: routed.why }
  }
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
