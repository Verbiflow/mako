import { z } from "zod"
import { AskOfferSchema, type Grant, type Kind, type Lease, type LeaseEvent, type Scope, type SourceAsk, type UnavailableReason } from "./borrow.js"

/**
 * Setup: what each place a project's Threads run in has for the project, and where each thing stands against its
 * source. One page per project, a place at a time (this Mac, each device of the account, the cloud), in six parts
 * always in this order: Needs you, Code, Files, Accounts and secrets, Tools, Services.
 *
 * Every row is a grant or a lease of the borrowing primitive (`@mako/protocol/borrow`), an agent's ask, or a place's
 * own reading of itself (the recipe's carry, prepare and processes, sign-ins and saved keys by name, a machine image's
 * tools, a "command not found" count). `setupView` derives every row from those, so the host, a dev fixture and the
 * cloud's broker answer the same page. Nothing here holds a value: names, versions, sizes and times only.
 */

export const SETUP_PARTS = ["needs", "code", "files", "access", "tools", "services"] as const
export type SetupPart = (typeof SETUP_PARTS)[number]
export type SetupListPart = Exclude<SetupPart, "needs">
export const SETUP_LIST_PARTS = ["code", "files", "access", "tools", "services"] as const satisfies readonly SetupListPart[]

export const SETUP_PART_TITLES = {
  needs: "Needs you",
  code: "Code",
  files: "Files",
  access: "Accounts and secrets",
  tools: "Tools",
  services: "Services",
} as const satisfies Record<SetupPart, string>

/** What each part's + adds. */
export const SETUP_PART_ADDS = {
  code: "Repository",
  files: "File or folder",
  access: "Access",
  tools: "Tool",
  services: "Service",
} as const satisfies Record<SetupListPart, string>

// ---- Places ----

export const PLATFORMS = ["mac", "linux", "windows", "other"] as const
export type Platform = (typeof PLATFORMS)[number]

/** A place a project's Threads run in: a device of the account's (this one, or another), or the cloud's machines. */
export const SetupPlaceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("device"),
      device: z.string().min(1).max(128),
      /** The device's own name ("MacBook Pro", "Studio"). */
      name: z.string().min(1).max(100),
      platform: z.enum(PLATFORMS),
      /** The device this page is read on. */
      here: z.boolean(),
      online: z.boolean(),
      lastSeen: z.number().int().nonnegative().optional(),
      /** When it became a device of the account. */
      since: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("cloud") }).strict(),
])
export type SetupPlace = z.infer<typeof SetupPlaceSchema>

/** A place's ID on the wire and in a URL: `cloud`, or `device:<id>`. */
export function placeId(place: SetupPlace): string {
  return place.kind === "cloud" ? "cloud" : `device:${place.device}`
}

/** The place's name as the place picker shows it. */
export function placeName(place: SetupPlace): string {
  return place.kind === "cloud" ? "Cloud" : place.name
}

/** How a sentence names the place's own copy: "Mac's", "Studio's", "the cloud's". */
export function placePossessive(place: SetupPlace): string {
  if (place.kind === "cloud") return "The cloud's"
  return place.platform === "mac" ? "Mac's" : `${place.name}'s`
}

// ---- Sync state ----

const At = z.number().int().nonnegative()
const Words = z.string().min(1).max(200)

/** Where one row stands against its source, said in a few words and one dot, never by colour alone. */
export const SyncStateSchema = z.discriminatedUnion("state", [
  /** The place has the source's current version. */
  z.object({ state: z.literal("synced"), at: At }).strict(),
  /** The source has a newer version than the place holds; Send takes it there. `source` is whose ("Mac's"). */
  z.object({ state: z.literal("newer"), source: Words }).strict(),
  /** A copy served while its source is offline, and how old it is. */
  z.object({ state: z.literal("stale"), since: At }).strict(),
  /** An agent asked for it and the person hasn't answered. */
  z.object({ state: z.literal("asked") }).strict(),
  /** The place hasn't got it, though another place has or a Thread needed it; Add gives it. */
  z.object({ state: z.literal("missing") }).strict(),
  /** It didn't reach the place, and its fixed reason in words ("couldn't be read"); Retry tries again. */
  z.object({ state: z.literal("failed"), why: Words }).strict(),
  /** It's this place's own and goes nowhere else. */
  z.object({ state: z.literal("here") }).strict(),
  /** An agent added it for its own Thread only; Keep puts it in the setup. */
  z.object({ state: z.literal("thread") }).strict(),
  /** A service the place runs, and the port it's up on. */
  z.object({ state: z.literal("up"), port: z.number().int().positive().max(65535).optional() }).strict(),
  /** A service reached through a device that's offline now. */
  z.object({ state: z.literal("offline"), through: Words }).strict(),
])
export type SyncState = z.infer<typeof SyncStateSchema>

export type SyncTone = "positive" | "caution" | "negative" | "attention" | "neutral"
/** What the row's one button does. */
export const RowActionSchema = z.enum(["send", "add", "retry", "keep", "stop"])
export type RowAction = z.infer<typeof RowActionSchema>

/** "just now", "12 min", "3 h", "2 d". */
export function age(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

function ago(at: number, now: number): string {
  const said = age(now - at)
  return said === "just now" ? said : `${said} ago`
}

/** A row's state as its end says it: a few words, the dot's tone, and the button it offers. */
export type SyncSaid = { words: string; tone: SyncTone; action?: RowAction }

export function syncWords(sync: SyncState, now: number): SyncSaid {
  switch (sync.state) {
    case "synced":
      return { words: `Synced ${ago(sync.at, now)}`, tone: "positive" }
    case "newer":
      return { words: `${sync.source} is newer`, tone: "caution", action: "send" }
    case "stale":
      return { words: `Copy · ${age(now - sync.since) === "just now" ? "just now" : `${age(now - sync.since)} old`}`, tone: "caution" }
    case "asked":
      return { words: "Waiting on you", tone: "attention" }
    case "missing":
      return { words: "Not here", tone: "negative", action: "add" }
    case "failed":
      return { words: `Didn't copy: ${sync.why}`, tone: "negative", action: "retry" }
    case "here":
      return { words: "Stays here", tone: "neutral" }
    case "thread":
      return { words: "This Thread only", tone: "neutral", action: "keep" }
    case "up":
      return { words: sync.port ? `Up on ${sync.port}` : "Up", tone: "positive" }
    case "offline":
      return { words: `${sync.through} offline`, tone: "caution" }
  }
}

/** Worse first: what a part's summary line leads with. */
const TONE_RANK = { attention: 0, negative: 1, caution: 2, neutral: 3, positive: 4 } as const satisfies Record<SyncTone, number>

// ---- Rows ----

export const RowIconSchema = z.enum(["repository", "file", "folder", "key", "tool", "service", "command"])
export type RowIcon = z.infer<typeof RowIconSchema>

/** What a place reads of itself, as a row's origin names it. */
export const SetupReadingSchema = z.enum([
  "repository",
  "recipe-carry",
  "carried-cloud",
  "recipe-prepare",
  "recipe-process",
  "image",
  "thread-tool",
  "command-not-found",
  "sign-in",
  "saved-key",
  "device-tools",
])
export type SetupReading = z.infer<typeof SetupReadingSchema>

const Id = z.string().min(1).max(400)

/** Where a row comes from: a grant, a lease under one, an agent's ask, or the place's own reading. */
export const RowOriginSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("grant"), grant: Id }).strict(),
  z.object({ from: z.literal("lease"), lease: Id, grant: Id }).strict(),
  z.object({ from: z.literal("ask"), ask: Id }).strict(),
  z.object({ from: z.literal("reading"), reading: SetupReadingSchema }).strict(),
])
export type RowOrigin = z.infer<typeof RowOriginSchema>

export const SetupRowSchema = z
  .object({
    id: Id,
    part: z.enum(SETUP_LIST_PARTS),
    icon: RowIconSchema,
    name: z.string().min(1).max(1024),
    /** A path, a command or a repository, drawn in the code face. */
    mono: z.boolean(),
    /** Where it comes from and how it's held, in one line. Names only, never a value. */
    detail: z.string().max(1000),
    scope: z.enum(["thread", "project", "account"]).optional(),
    /** The Thread a Thread-scoped grant reaches, so one Thread's own place leaves out another's. */
    thread: Id.optional(),
    sync: SyncStateSchema,
    origin: RowOriginSchema,
    /** The row's button when it isn't its state's own (Stop on what this device lends). */
    action: RowActionSchema.optional(),
    /** What an action acts on: a carried file's path, a tool's name. */
    target: z.string().max(1024).optional(),
  })
  .strict()
export type SetupRow = z.infer<typeof SetupRowSchema>

/** The row's one button: its own, or its state's. Away from its Mac (`SetupView.away`), only Stop does anything. */
export function rowAction(row: SetupRow, now: number, away = false): RowAction | undefined {
  const action = row.action ?? syncWords(row.sync, now).action
  return away && action !== "stop" ? undefined : action
}

export const ROW_ACTION_LABELS = { send: "Send", add: "Add", retry: "Retry", keep: "Keep", stop: "Stop" } as const satisfies Record<RowAction, string>

export const SCOPE_WORDS = { thread: "Thread", project: "Project", account: "Account" } as const satisfies Record<Scope["level"], string>

// ---- Asks ----

/** Who asked: the Thread (or Fin) as the person knows it. */
export const AskerSchema = z
  .object({ thread: z.string().min(1).max(128), title: z.string().max(200), harness: z.string().max(64).optional(), fin: z.boolean() })
  .strict()
export type Asker = z.infer<typeof AskerSchema>

/**
 * An agent's ask, waiting on the person: a borrow nothing grants yet (the broker's `AskOffer`, `answer: "grant"`), a
 * borrow whose grant asks this device's person first (a `SourceAsk` with `askPerson`, `answer: "source"`), or a tool
 * the place lacks. An answer becomes a grant, the source's yes or no, or the tool goes into the recipe's prepare;
 * agents never add to Setup themselves.
 */
const AskBase = { id: Id, by: AskerSchema, at: At, why: z.string().max(500), /** The place the asking Thread runs in. */ place: Id }
export const SetupAskSchema = z.discriminatedUnion("kind", [
  z.object({ ...AskBase, kind: z.literal("borrow"), offer: AskOfferSchema, answer: z.enum(["grant", "source"]) }).strict(),
  z.object({ ...AskBase, kind: z.literal("tool"), tool: z.string().min(1).max(200), version: z.string().max(80).optional() }).strict(),
])
export type SetupAsk = z.infer<typeof SetupAskSchema>

export const ASK_ANSWERS = ["allow-thread", "allow-project", "decline", "add-to-setup"] as const
export const AskAnswerSchema = z.enum(ASK_ANSWERS)
export type AskAnswer = z.infer<typeof AskAnswerSchema>

/** The answers an ask offers, the one for the narrowest reach first. Away from its Mac (`SetupView.away`), only no. */
export function askAnswers(ask: SetupAsk, away = false): AskAnswer[] {
  if (away) return ["decline"]
  if (ask.kind === "tool") return ["add-to-setup", "decline"]
  // A source's yes is for the borrower that asked; widening it is a grant of its own, given in Setup.
  if (ask.answer === "grant") return ["allow-thread", "allow-project", "decline"]
  // A command or a port is run or reached by its device's own source, which no device has yet: only no can be said.
  const { kind } = ask.offer.resource
  return kind === "command" || kind === "port" ? ["decline"] : ["allow-thread", "decline"]
}

/**
 * A source's ask of this device's person (`LocalBorrowing.asks`, the account broker's `/v1/borrow/asks`) as Setup's:
 * the borrower's Thread as the person knows it, what it wants and why, at the place it runs.
 */
export function sourceAskOf(waiting: { ask: SourceAsk; at: number }, place: string, by: Asker): SetupAsk {
  const { ask } = waiting
  return {
    id: ask.ask,
    kind: "borrow",
    answer: "source",
    by,
    at: waiting.at,
    why: ask.why,
    place,
    offer: {
      resource: { kind: ask.resource.kind, ref: ask.ref },
      borrower: ask.borrower,
      why: ask.why,
      scope: { level: "thread", account: ask.borrower.account, thread: ask.borrower.thread },
      mode: ask.mode,
    },
  }
}

/** An answer's button. `compact` for a side panel or a phone, where the shorter words fit. */
export function askAnswerLabel(ask: SetupAsk, answer: AskAnswer, compact = false): string {
  switch (answer) {
    case "allow-thread":
      return compact ? "For this Thread" : "Allow for this Thread"
    case "allow-project":
      return compact ? "For the project" : "Allow for the project"
    case "decline":
      return "Decline"
    case "add-to-setup":
      return compact || ask.kind !== "tool" ? "Add to setup" : `Add ${ask.tool}${ask.version ? ` ${ask.version}` : ""} to setup`
  }
}

/** The ask as one line after its Thread's name: what it wants, the thing named in the code face, and what follows. */
export type AskLine = { verb: string; thing: string; after?: string }

export function askLine(ask: SetupAsk): AskLine {
  if (ask.kind === "tool") return { verb: "ran", thing: ask.tool, after: "which the machine lacks" }
  const { kind, ref } = ask.offer.resource
  const github = githubRef(kind, ref)
  if (github) return { verb: "wants to read", thing: github }
  switch (kind) {
    case "file":
    case "tree":
      return { verb: ask.offer.mode === "live" ? "wants to read" : "wants a copy of", thing: ref }
    case "env":
      return { verb: "wants", thing: ref }
    case "credential":
      return { verb: "wants access to", thing: ref }
    case "command":
      return { verb: "wants to run", thing: ref }
    case "port":
      return { verb: "wants to reach", thing: ref }
    case "operation":
      return { verb: "wants to use", thing: ref }
  }
}

/** The part an ask's row stands in. */
export function askPart(ask: SetupAsk): SetupListPart {
  return ask.kind === "tool" ? "tools" : kindPart(ask.offer.resource.kind, ask.offer.resource.ref)
}

/**
 * The grant an answer makes, for a borrow: the ask's offer with its scope as the person chose, from the source the
 * broker found holding it (a GitHub repository is always minted). Undefined for Decline and for a tool, which goes
 * into the recipe instead.
 */
export function grantForAnswer(
  ask: SetupAsk,
  answer: AskAnswer,
  made: { id: string; account: string; source: Grant["source"]; device?: string; at: number }
): Grant | undefined {
  if (ask.kind !== "borrow" || (answer !== "allow-thread" && answer !== "allow-project")) return undefined
  const { offer } = ask
  const scope: Scope =
    answer === "allow-thread"
      ? { level: "thread", account: made.account, thread: offer.borrower.thread }
      : { level: "project", account: made.account, repository: offer.borrower.repository }
  const source: Grant["source"] = githubRef(offer.resource.kind, offer.resource.ref) ? { kind: "mint", service: "github" } : made.source
  return {
    id: made.id,
    resource: offer.resource,
    source,
    scope,
    mode: offer.mode,
    access: offer.resource.kind === "command" || offer.resource.kind === "port" ? "run" : "read",
    lifetime: answer === "allow-thread" ? { until: "thread-ends" } : { until: "revoked" },
    ask: source.kind === "device" ? "first-use" : "never",
    secret: offer.resource.kind === "env" || offer.resource.kind === "credential",
    grantedBy: { kind: "person", account: made.account, ...(made.device && { device: made.device }) },
    grantedAt: made.at,
    version: 1,
  }
}

// ---- Input ----

/** A place's own reading of itself: what it holds that no grant says, with where each stands. */
export type PlaceReading = {
  place: SetupPlace
  /** The cloud's base: when it was built, from what, how long it took and how large it is. */
  base?: { builtAt: number; branch: string; commit: string; tookMs: number; bytes: number }
  /** The main checkout's folder, for this device. */
  checkout?: string
  rows: Array<Omit<SetupRow, "id" | "origin"> & { reading: SetupReading; id?: string }>
}

/** What the broker says for the project: its standing grants, live leases, recent refusals and pending asks. */
export type BrokerReading = {
  account: string
  grants: Grant[]
  leases: Lease[]
  /** Recent refusals (`refused` events), newest last, each with its fixed reason when the broker knows it; never a source's words. */
  refusals: Array<LeaseEvent & { reason?: UnavailableReason }>
  asks: SetupAsk[]
  /** Each grant's current version at its source, when the source reports one: a copy behind it is "newer" there. */
  sourceVersions: Record<string, string>
  /** The account's devices, by ID: a device-sourced row names it. */
  devices: Record<string, { name: string; platform: Platform; online: boolean; lastSeen: number | null }>
}

/** What one broker says, as Setup reads it: standing grants, live leases, its log since a time, and the asks waiting on this device's person. */
export type BorrowSnapshot = { grants: Grant[]; leases: Lease[]; events: LeaseEvent[]; asks: Array<{ ask: SourceAsk; at: number }> }

export type SetupInput = {
  now: number
  project: { name: string; root: string; repository: string | null }
  places: PlaceReading[]
  broker?: BrokerReading
  /** This project's Threads, so a grant scoped to one of them is shown in its project's Setup. */
  threads?: string[]
}

// ---- Output ----

export const SetupPartViewSchema = z.object({ part: z.enum(SETUP_LIST_PARTS), rows: z.array(SetupRowSchema) }).strict()
export type SetupPartView = z.infer<typeof SetupPartViewSchema>

export const SetupPlaceViewSchema = z
  .object({
    id: Id,
    place: SetupPlaceSchema,
    title: z.string().max(100),
    /** What the place is, in one line. */
    line: z.string().max(1000),
    asks: z.array(SetupAskSchema),
    parts: z.array(SetupPartViewSchema),
  })
  .strict()
export type SetupPlaceView = z.infer<typeof SetupPlaceViewSchema>

/** A project's page: every place, its asks and its five parts. What a host, the account's broker and a fixture answer. */
export const SetupViewSchema = z
  .object({
    project: z.string().max(200),
    root: z.string().max(1024),
    repository: z.string().max(200).nullable(),
    places: z.array(SetupPlaceViewSchema),
    /** When it was read. */
    at: At,
    /**
     * Built from the account broker alone, away from any Mac (`accountSetupView`): it sees what the account lends and
     * nothing of a device's own, and can only say no or stop a grant. Absent on a host's page.
     */
    away: z.literal(true).optional(),
  })
  .strict()
export type SetupView = z.infer<typeof SetupViewSchema>

/** What a page built away from the Mac says of itself, for what it can't see. */
export const SETUP_AWAY_NOTE = "This shows what your account lends. Open Setup on your Mac for the rest."
/** What an ask says in place of the answers only its source can give. */
export const SETUP_AWAY_ALLOW = "Allow it on your Mac"
/** A part with nothing in it, on a page that can only see grants: it says no more than that. */
export const SETUP_AWAY_EMPTY = "No grants"

// ---- Derivation ----

/** A `credential` grant whose ref is `github:<owner>/<name>` is read access to that repository: a row in Code. */
export function githubRef(kind: Kind, ref: string): string | undefined {
  return kind === "credential" && ref.startsWith("github:") ? ref.slice("github:".length) : undefined
}

function kindPart(kind: Kind, ref: string): SetupListPart {
  if (githubRef(kind, ref)) return "code"
  switch (kind) {
    case "file":
    case "tree":
      return "files"
    case "env":
    case "credential":
      return "access"
    case "command":
    case "operation":
      return "tools"
    case "port":
      return "services"
  }
}

function kindIcon(kind: Kind, ref: string): RowIcon {
  if (githubRef(kind, ref)) return "repository"
  return ({ file: "file", tree: "folder", env: "key", credential: "key", command: "command", port: "service", operation: "tool" } as const)[kind]
}

/** Whether a borrower runs at a place. */
function atPlace(lease: Lease, place: SetupPlace): boolean {
  if (place.kind === "cloud") return lease.borrower.place.kind === "machine"
  return lease.borrower.place.kind === "device" && lease.borrower.place.device === place.device
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
function day(at: number): string {
  const date = new Date(at)
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
}

function sourceName(source: Grant["source"], broker: BrokerReading): string {
  if (source.kind === "vault") return "your account"
  if (source.kind === "mint") return source.service === "github" ? "Mako's GitHub app" : `the ${source.service} service`
  if (source.kind === "capable") {
    const named = source.devices?.map((device) => broker.devices[device]?.name ?? "another device")
    return named?.length ? named.join(" or ") : `any of your devices with ${source.requires.map((query) => query.capability).join(" and ")}`
  }
  return broker.devices[source.device]?.name ?? "another device"
}

/** A grant's one line: how it's held, from where, for how long. Names only. */
export function grantDetail(grant: Grant, broker: BrokerReading, leases: Lease[], lent: boolean): string {
  const from = sourceName(grant.source, broker)
  const parts: string[] = []
  if (lent) {
    const borrowers = new Set(leases.map((lease) => lease.borrower.thread)).size
    parts.push(borrowers ? `Read by ${borrowers} ${borrowers === 1 ? "Thread" : "Threads"} elsewhere` : "Lent to Threads elsewhere while this device is online")
  } else
    switch (grant.mode) {
      case "copy":
        parts.push(grant.source.kind === "device" ? `A copy from ${from}` : `Kept encrypted in ${from}`)
        break
      case "live":
        parts.push(`Read live from ${from} while it's online`)
        break
      case "minted":
        parts.push(`From ${from}, an hour at a time, nothing stored`)
        break
      case "proxy":
        parts.push("Through Mako's proxy, so the value never enters a process")
        break
      case "relay":
        parts.push(`Runs on ${from}, output sent back`)
        break
    }
  if (grant.access === "write") parts.push("changes go back")
  else if (grant.access === "read" && (grant.resource.kind === "file" || grant.resource.kind === "tree" || githubRef(grant.resource.kind, grant.resource.ref))) parts.push("read-only")
  if (grant.secret) parts.push("agents see names only")
  if (grant.ask === "each-use") parts.push("asks each time")
  if (grant.lifetime.until === "expires") parts.push(`lapses ${day(grant.lifetime.at)}`)
  if (grant.lifetime.until === "thread-ends") parts.push("until its Thread ends")
  // A pattern's leases are each a thing of its own, listed under it with theirs.
  const size = /[*?]/.test(grant.resource.ref) ? undefined : leases.find((lease) => lease.delivery.size !== undefined)?.delivery.size
  if (size !== undefined && !lent) parts.push(bytes(size))
  return parts.join(" · ")
}

/** "2 KB", "41 MB", "1.6 GB". */
export function bytes(count: number): string {
  if (count < 1024) return `${count} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = count / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Why a copy didn't land, as the source's fixed reason (`UNAVAILABLE_REASONS`), in words. Never a source's own words. */
const REASON_WORDS = {
  "not-found": "not at its source",
  outside: "outside its folder",
  unreadable: "couldn't be read",
  changed: "it changed while copying",
  "no-value": "nothing saved for it",
  error: "its source failed",
} as const satisfies Record<UnavailableReason, string>

/** A refusal as a copy that didn't land says it: by its reason, else by its code. */
function refusalWords(code: string, reason: UnavailableReason | undefined): string {
  if (reason) return REASON_WORDS[reason]
  switch (code) {
    case "too-large":
      return "too large"
    case "unavailable":
      return "the source couldn't read it"
    case "source-offline":
      return "its source is offline"
    case "declined":
      return "declined at its source"
    default:
      return code
  }
}

/** Where a grant stands at a place: by its leases there, a refusal, or the grant alone. */
export function grantSync(grant: Grant, leases: Lease[], broker: BrokerReading, place: SetupPlace): SyncState {
  const stale = leases.find((lease) => lease.stale)
  if (stale?.stale) return { state: "stale", since: stale.stale.heldSince }
  const current = broker.sourceVersions[grant.id]
  if (grant.mode === "copy" && current && leases.some((lease) => lease.version !== current)) {
    const source = grant.source.kind === "device" ? broker.devices[grant.source.device] : undefined
    return { state: "newer", source: source ? (source.platform === "mac" ? "Mac's" : `${source.name}'s`) : "The source's" }
  }
  const latest = leases.reduce<Lease | undefined>((newest, lease) => (!newest || lease.issuedAt > newest.issuedAt ? lease : newest), undefined)
  if (latest) return { state: "synced", at: latest.issuedAt }
  const refused = [...broker.refusals].reverse().find((event) => event.grant === grant.id && (place.kind === "cloud" ? event.borrower.place.kind === "machine" : event.borrower.place.kind === "device" && event.borrower.place.device === place.device))
  if (refused?.refused && refused.refused !== "no-grant") return { state: "failed", why: refusalWords(refused.refused, refused.reason) }
  if (grant.source.kind === "device" && (grant.mode === "live" || grant.mode === "relay")) {
    const device = broker.devices[grant.source.device]
    if (device && !device.online) return grant.resource.kind === "port" ? { state: "offline", through: device.name } : { state: "stale", since: device.lastSeen ?? grant.grantedAt }
  }
  return { state: "synced", at: grant.grantedAt }
}

/** Whether a grant is shown at a place: it can reach a borrower there, or the place is its source lending it. */
function grantAt(grant: Grant, place: SetupPlace, repository: string | null, threads: ReadonlySet<string>): "held" | "lent" | undefined {
  if (grant.scope.level === "project" && grant.scope.repository !== repository) return undefined
  if (grant.scope.level === "thread" && !threads.has(grant.scope.thread)) return undefined
  const source = grant.source.kind === "device" ? grant.source.device : undefined
  if (place.kind === "device" && source === place.device) return grant.within === "source-device" ? "held" : "lent"
  if (grant.within === "source-device") return undefined
  return "held"
}

function refusedAt(broker: BrokerReading, grant: Grant, place: SetupPlace): boolean {
  return broker.refusals.some((event) => event.grant === grant.id && (place.kind === "cloud" ? event.borrower.place.kind === "machine" : event.borrower.place.kind === "device" && event.borrower.place.device === place.device))
}

/** What this device lends, as its own page says it: newer here (Send), or in step since its last lease (or since it was given). */
function lentSync(grant: Grant, leases: Lease[], broker: BrokerReading, place: SetupPlace): SyncState {
  const current = broker.sourceVersions[grant.id]
  if (grant.mode === "copy" && current && leases.some((lease) => lease.version !== current)) return { state: "newer", source: placePossessive(place) }
  const latest = leases.reduce((newest, lease) => Math.max(newest, lease.issuedAt), 0)
  return { state: "synced", at: latest || grant.grantedAt }
}

/** Whether a ref is a pattern (`**`, `*.env`): its leases, one per thing taken, are rows of their own. */
const PATTERN = /[*?]/

function leaseRows(grant: Grant, leases: Lease[]): SetupRow[] {
  const byRef = new Map<string, Lease[]>()
  for (const lease of leases) byRef.set(lease.resource.ref, [...(byRef.get(lease.resource.ref) ?? []), lease])
  return [...byRef].map(([ref, held]): SetupRow => {
    const worktrees = new Set(held.map((lease) => lease.borrower.thread)).size
    const latest = held.reduce((newest, lease) => Math.max(newest, lease.issuedAt), 0)
    const kind = held[0]!.resource.kind
    const placed = grant.mode === "live" ? "Linked into" : "Copied into"
    return {
      id: `lease:${grant.id}:${ref}`,
      part: kindPart(kind, ref),
      icon: kindIcon(kind, ref),
      name: ref,
      mono: true,
      detail: `${placed} ${worktrees} ${worktrees === 1 ? "Thread's worktree" : "Threads' worktrees"}${grant.secret ? " · agents see names only" : ""}`,
      scope: grant.scope.level,
      ...(grant.scope.level === "thread" && { thread: grant.scope.thread }),
      sync: { state: "synced", at: latest },
      origin: { from: "lease", lease: held[0]!.id, grant: grant.id },
      target: grant.id,
    }
  })
}

function grantRows(broker: BrokerReading, place: SetupPlace, project: { repository: string | null; root: string }, threads: ReadonlySet<string>): SetupRow[] {
  const rows: SetupRow[] = []
  const repository = project.repository
  // A device's own broker names a borrower's project by its main checkout's folder; the account's by owner/name.
  const ours = (lease: Lease) => lease.borrower.repository === repository || lease.borrower.repository === project.root
  for (const grant of broker.grants) {
    const shown = grantAt(grant, place, repository, threads)
    if (!shown) continue
    const leases = broker.leases.filter((lease) => lease.grant === grant.id && ours(lease) && (shown === "lent" ? !atPlace(lease, place) : atPlace(lease, place)))
    // Another device holds a grant only once something was leased or refused there; the cloud's machines take every one as they start.
    if (shown === "held" && place.kind === "device" && grant.within !== "source-device" && !leases.length && !refusedAt(broker, grant, place)) continue
    const { kind, ref } = grant.resource
    const github = githubRef(kind, ref)
    const row: SetupRow = {
      id: `grant:${grant.id}`,
      part: kindPart(kind, ref),
      icon: kindIcon(kind, ref),
      name: grant.label ?? github ?? ref,
      mono: !grant.label || Boolean(github),
      detail: grantDetail(grant, broker, leases, shown === "lent"),
      scope: grant.scope.level,
      ...(grant.scope.level === "thread" && { thread: grant.scope.thread }),
      sync: shown === "lent" ? lentSync(grant, leases, broker, place) : grantSync(grant, leases, broker, place),
      origin: leases.length === 1 && !PATTERN.test(ref) ? { from: "lease", lease: leases[0]!.id, grant: grant.id } : { from: "grant", grant: grant.id },
      target: grant.id,
    }
    // What this device is the source of, the person can stop here: lent to other places, or kept to its own Threads.
    const own = place.kind === "device" && grant.source.kind === "device" && grant.source.device === place.device
    if (own && row.sync.state !== "newer") row.action = "stop"
    rows.push(row)
    if (PATTERN.test(ref) && shown === "held") rows.push(...leaseRows(grant, leases))
  }
  return rows
}

function askRow(ask: SetupAsk, now: number): SetupRow {
  const line = askLine(ask)
  return {
    id: `ask:${ask.id}`,
    part: askPart(ask),
    icon: ask.kind === "tool" ? "tool" : kindIcon(ask.offer.resource.kind, ask.offer.resource.ref),
    name: line.thing,
    mono: true,
    detail: `Asked for by ${ask.by.title}, ${ago(ask.at, now)}`,
    sync: { state: "asked" },
    origin: { from: "ask", ask: ask.id },
    target: ask.id,
  }
}

/** What a place is, in one line. */
export function placeLine(reading: PlaceReading, now: number): string {
  const { place } = reading
  if (place.kind === "cloud") {
    const base = reading.base
    if (!base) return "Each Thread gets a machine of its own, set up by this project's recipe as it starts."
    return `Each Thread gets a machine of its own, started from this project's base: built ${ago(base.builtAt, now)} from ${base.branch} ${base.commit.slice(0, 6)} in ${duration(base.tookMs)}, ${bytes(base.bytes)}.`
  }
  const kind = place.platform === "mac" ? "Mac" : place.platform === "linux" ? "Linux machine" : place.platform === "windows" ? "Windows machine" : "device"
  if (place.here) {
    const where = reading.checkout ? `worktrees of ${reading.checkout}` : "worktrees of the main checkout"
    return `This ${kind}, online. Threads here work in ${where}; what Git ignores comes from the main checkout.`
  }
  const since = place.since ? `, a device of this account since ${day(place.since)}` : ""
  const seen = place.online ? "Online now." : place.lastSeen ? `Last online ${ago(place.lastSeen, now)}.` : "Offline."
  return `A ${kind} of yours${since}. ${seen}`
}

/** "1 min 12 s", "48 s". */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`
}

/** Places in the picker's order: this device, the cloud, then the others by name. */
function placeOrder(left: SetupPlace, right: SetupPlace): number {
  const rank = (place: SetupPlace) => (place.kind === "device" && place.here ? 0 : place.kind === "cloud" ? 1 : 2)
  return rank(left) - rank(right) || placeName(left).localeCompare(placeName(right))
}

/**
 * The page: for each place, its asks first, then its rows in five parts. A grant's or an ask's row replaces a reading of
 * the same thing (a carried file the broker now grants, a missing tool an agent asked for), and an ask's row stands in
 * its part as well as in Needs you.
 */
export function setupView(input: SetupInput): SetupView {
  const { now, project, broker } = input
  const threads = new Set(input.threads ?? [])
  const places = [...input.places].sort((left, right) => placeOrder(left.place, right.place))
  return {
    project: project.name,
    root: project.root,
    repository: project.repository,
    at: now,
    places: places.map((reading) => {
      const id = placeId(reading.place)
      const asks = (broker?.asks ?? []).filter((ask) => ask.place === id).sort((left, right) => left.at - right.at)
      const granted = broker ? grantRows(broker, reading.place, project, threads) : []
      const asked = asks.map((ask) => askRow(ask, now))
      const names = new Set([...granted, ...asked].map((row) => `${row.part}\0${row.name}`))
      const read = reading.rows
        .filter((row) => !names.has(`${row.part}\0${row.name}`))
        .map(({ reading: from, id: given, ...row }, index): SetupRow => ({ ...row, id: given ?? `reading:${from}:${index}:${row.name}`, origin: { from: "reading", reading: from } }))
      const rows = [...read, ...granted, ...asked]
      return {
        id,
        place: reading.place,
        title: placeName(reading.place),
        line: placeLine(reading, now),
        asks,
        parts: SETUP_LIST_PARTS.map((part) => ({ part, rows: rows.filter((row) => row.part === part) })),
      }
    }),
  }
}

/** A part folded to one line, as the phone lists it: its first names, then the worst state said. */
export type PartSummary = { line: string; tone: SyncTone }

export function partSummary(part: SetupPartView, now: number, away = false): PartSummary {
  if (!part.rows.length) return { line: away ? SETUP_AWAY_EMPTY : "Nothing yet", tone: "neutral" }
  const ranked = part.rows.map((row) => ({ row, said: syncWords(row.sync, now) })).sort((left, right) => TONE_RANK[left.said.tone] - TONE_RANK[right.said.tone])
  const worst = ranked[0]!
  const names = part.rows.filter((row) => row !== worst.row).slice(0, 2).map((row) => row.name)
  const more = part.rows.length - 1 - names.length
  const rest = [...names, ...(more > 0 ? [`${more} more`] : [])].join(", ")
  if (worst.said.tone === "positive" || worst.said.tone === "neutral") return { line: part.rows.slice(0, 3).map((row) => row.name).join(", ") + (part.rows.length > 3 ? `, ${part.rows.length - 3} more` : ""), tone: worst.said.tone }
  const lead = `${worst.row.name}: ${worst.said.words.charAt(0).toLowerCase()}${worst.said.words.slice(1)}`
  return { line: rest ? `${lead} · ${rest}` : lead, tone: worst.said.tone }
}

/** Every ask waiting on the person across a view's places, oldest first: the Inbox's and the phone's count. */
export function viewAsks(view: SetupView): SetupAsk[] {
  return view.places.flatMap((place) => place.asks).sort((left, right) => left.at - right.at)
}

/**
 * One Thread's own place, for its side panel: its place's rows, with its own asks alone and grants scoped to other
 * Threads left out.
 */
export function threadPlace(view: SetupView, place: string, thread: string): SetupPlaceView | undefined {
  const found = view.places.find((entry) => entry.id === place)
  if (!found) return undefined
  const asks = found.asks.filter((ask) => ask.by.thread === thread)
  const keepAsk = new Set(asks.map((ask) => ask.id))
  return {
    ...found,
    asks,
    parts: found.parts.map((part) => ({
      part: part.part,
      rows: part.rows.filter((row) => {
        if (row.origin.from === "ask") return keepAsk.has(row.origin.ask)
        return !row.thread || row.thread === thread
      }),
    })),
  }
}

// ---- Acting ----

/** What the person does on the page. Each is one tap; an agent never sends one. */
export const SetupActSchema = z.discriminatedUnion("act", [
  z.object({ act: z.literal("answer"), ask: z.string().min(1).max(200), answer: AskAnswerSchema }).strict(),
  /** A row's button: Send, Add, Retry, Keep or Stop, on the row it names. */
  z.object({ act: z.literal("row"), place: z.string().min(1).max(200), row: z.string().min(1).max(400), action: z.enum(["send", "add", "retry", "keep", "stop"]) }).strict(),
  /** Rebuild the cloud's base now. */
  z.object({ act: z.literal("rebuild") }).strict(),
])
export type SetupAct = z.infer<typeof SetupActSchema>

/** Whether an act went through, and why not in the person's words. The page reads itself again either way. */
export const SetupActOutcomeSchema = z.union([z.object({ done: z.literal(true) }).strict(), z.object({ done: z.literal(false), why: Words }).strict()])
export type SetupActOutcome = z.infer<typeof SetupActOutcomeSchema>

/** What an add in the Add menu is, by part: the menu's rows, in its order. */
export const SETUP_ADDITIONS = [
  { part: "files", title: "A file or folder from this Mac", detail: "Copied, or read live while the Mac is online" },
  { part: "access", title: "An account or secret", detail: "A service's token or an env value, by name; never shown again" },
  { part: "tools", title: "A tool", detail: "Added to the recipe's prepare, so every Thread has it" },
  { part: "code", title: "A repository to read", detail: "Another of the owner's, read-only" },
  { part: "services", title: "A service on your network", detail: "Reached through this Mac while it's online" },
] as const satisfies ReadonlyArray<{ part: SetupListPart; title: string; detail: string }>

/** A device as the account lists it, for the places a browser away from the Mac shows. */
export type AccountDevice = { id: string; name: string; platform: string; lastSeenAt?: string }

function platformOf(text: string): Platform {
  return /mac/i.test(text) ? "mac" : /linux/i.test(text) ? "linux" : /windows/i.test(text) ? "windows" : "other"
}

/**
 * A project's page as a browser away from the Mac builds it from the account broker alone (`/v1/borrow/grants`,
 * `/leases`, `/events`, `/asks`): the cloud's place and each device of the account's, every row by `setupView`. The
 * project is its folder's name; its repository is the one the broker's grants, leases or asks name that ends with it.
 * A device's own readings (its recipe, its own brokers) are its host's to say, so a device place here shows only what
 * the account's broker holds for it, and the page says so (`away`).
 */
export function accountSetupView(input: {
  now: number
  project: string
  snapshot: BorrowSnapshot
  devices: readonly AccountDevice[]
  /** The asking Thread as the account lists it, by its ID; an ask from one it doesn't list says "A Thread". */
  askers?: (thread: string) => Omit<Asker, "thread"> | undefined
}): SetupView {
  const { now, project, snapshot } = input
  const named = [
    ...snapshot.grants.flatMap((grant) => (grant.scope.level === "project" ? [grant.scope.repository] : [])),
    ...snapshot.leases.map((lease) => lease.borrower.repository),
    ...snapshot.asks.map((waiting) => waiting.ask.borrower.repository),
  ]
  const repository = named.find((name) => name.split("/").at(-1) === project) ?? null
  const places: PlaceReading[] = [
    {
      place: { kind: "cloud" },
      rows: repository ? [{ reading: "repository", part: "code", icon: "repository", name: repository, mono: true, detail: "Clones main, pushes its own branch, opens pull requests as Mako", sync: { state: "synced", at: now } }] : [],
    },
    ...input.devices.map((device): PlaceReading => {
      const lastSeen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : undefined
      const place: SetupPlace = { kind: "device", device: device.id, name: device.name, platform: platformOf(device.platform), here: false, online: false }
      if (lastSeen !== undefined && Number.isFinite(lastSeen)) place.lastSeen = lastSeen
      return { place, rows: [] }
    }),
  ]
  const ours = (borrower: { repository: string }) => repository !== null && borrower.repository === repository
  const asks = snapshot.asks
    .filter((waiting) => waiting.ask.askPerson && ours(waiting.ask.borrower))
    .map((waiting) => {
      const { ask } = waiting
      const where = ask.borrower.place
      // When it was asked: the broker's log line for it, the newest of that Thread's for that grant and name.
      const asked = snapshot.events
        .filter((event) => event.event === "asked" && event.grant === ask.grant && event.borrower.thread === ask.borrower.thread && event.resource.ref === ask.ref)
        .reduce<number | undefined>((latest, event) => Math.max(latest ?? 0, event.at), undefined)
      const asker = input.askers?.(ask.borrower.thread)
      return sourceAskOf({ ask, at: asked ?? waiting.at }, where.kind === "machine" ? "cloud" : `device:${where.device}`, { thread: ask.borrower.thread, title: asker?.title ?? "A Thread", fin: asker?.fin ?? false, ...(asker?.harness && { harness: asker.harness }) })
    })
  const broker: BrokerReading = {
    account: snapshot.grants[0]?.scope.account ?? "",
    grants: snapshot.grants,
    leases: snapshot.leases,
    refusals: snapshot.events.filter((event) => event.event === "refused"),
    asks,
    sourceVersions: {},
    devices: Object.fromEntries(input.devices.map((device) => [device.id, { name: device.name, platform: platformOf(device.platform), online: false, lastSeen: device.lastSeenAt ? Date.parse(device.lastSeenAt) || null : null }])),
  }
  const threads = [...new Set([...snapshot.leases.filter((lease) => ours(lease.borrower)).map((lease) => lease.borrower.thread), ...asks.map((ask) => ask.by.thread)])]
  return { ...setupView({ now, project: { name: project, root: project, repository }, places, broker, threads }), away: true }
}
