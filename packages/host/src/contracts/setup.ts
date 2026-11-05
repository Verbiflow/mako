import { z } from "zod"
import type { AskOffer, Grant, Kind, Lease, LeaseEvent, Scope, SourceAsk, UnavailableReason } from "@mako/protocol/borrow"

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
export const SETUP_LIST_PARTS = SETUP_PARTS.filter((part): part is SetupListPart => part !== "needs")

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

/** Where one row stands against its source, said in a few words and one dot, never by colour alone. */
export type SyncState =
  /** The place has the source's current version. */
  | { state: "synced"; at: number }
  /** The source has a newer version than the place holds; Send takes it there. `source` is whose ("Mac's"). */
  | { state: "newer"; source: string }
  /** A copy served while its source is offline, and how old it is. */
  | { state: "stale"; since: number }
  /** An agent asked for it and the person hasn't answered. */
  | { state: "asked" }
  /** The place hasn't got it, though another place has or a Thread needed it; Add gives it. */
  | { state: "missing" }
  /** It didn't reach the place, and why in a few words ("disk full"); Retry tries again. */
  | { state: "failed"; why: string }
  /** It's this place's own and goes nowhere else. */
  | { state: "here" }
  /** An agent added it for its own Thread only; Keep puts it in the setup. */
  | { state: "thread" }
  /** A service the place runs, and the port it's up on. */
  | { state: "up"; port?: number }
  /** A service reached through a device that's offline now. */
  | { state: "offline"; through: string }

export type SyncTone = "positive" | "caution" | "negative" | "attention" | "neutral"
/** What the row's one button does. */
export type RowAction = "send" | "add" | "retry" | "keep" | "stop"

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

export type RowIcon = "repository" | "file" | "folder" | "key" | "tool" | "service" | "command"

/** What a place reads of itself, as a row's origin names it. */
export type SetupReading =
  | "repository"
  | "recipe-carry"
  | "carried-cloud"
  | "recipe-prepare"
  | "recipe-process"
  | "image"
  | "thread-tool"
  | "command-not-found"
  | "sign-in"
  | "saved-key"
  | "device-tools"

/** Where a row comes from: a grant, a lease under one, an agent's ask, or the place's own reading. */
export type RowOrigin =
  | { from: "grant"; grant: string }
  | { from: "lease"; lease: string; grant: string }
  | { from: "ask"; ask: string }
  | { from: "reading"; reading: SetupReading }

export type SetupRow = {
  id: string
  part: SetupListPart
  icon: RowIcon
  name: string
  /** A path, a command or a repository, drawn in the code face. */
  mono: boolean
  /** Where it comes from and how it's held, in one line. Names only, never a value. */
  detail: string
  scope?: Scope["level"]
  sync: SyncState
  origin: RowOrigin
  /** The row's button when it isn't its state's own (Stop on what this device lends). */
  action?: RowAction
  /** What an action acts on: a carried file's path, a tool's name. */
  target?: string
}

/** The row's one button: its own, or its state's. */
export function rowAction(row: SetupRow, now: number): RowAction | undefined {
  return row.action ?? syncWords(row.sync, now).action
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
export type SetupAsk = {
  id: string
  by: Asker
  at: number
  why: string
  /** The place the asking Thread runs in. */
  place: string
} & ({ kind: "borrow"; offer: AskOffer; answer: "grant" | "source" } | { kind: "tool"; tool: string; version?: string })

export const ASK_ANSWERS = ["allow-thread", "allow-project", "decline", "add-to-setup"] as const
export const AskAnswerSchema = z.enum(ASK_ANSWERS)
export type AskAnswer = z.infer<typeof AskAnswerSchema>

/** The answers an ask offers, the one for the narrowest reach first. */
export function askAnswers(ask: SetupAsk): AskAnswer[] {
  if (ask.kind === "tool") return ["add-to-setup", "decline"]
  // A source's yes is for the borrower that asked; widening it is a grant of its own, given in Setup.
  return ask.answer === "source" ? ["allow-thread", "decline"] : ["allow-thread", "allow-project", "decline"]
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
  /** Recent refusals (`refused` events), newest last, each with its fixed reason when one was given; never a source's words. */
  refusals: Array<LeaseEvent & { reason?: SetupFailure }>
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

export type SetupPartView = { part: SetupListPart; rows: SetupRow[] }

export type SetupPlaceView = {
  id: string
  place: SetupPlace
  title: string
  /** What the place is, in one line. */
  line: string
  asks: SetupAsk[]
  parts: SetupPartView[]
}

export type SetupView = {
  project: string
  root: string
  repository: string | null
  places: SetupPlaceView[]
  /** When it was read. */
  at: number
}

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
      return "tools"
    case "port":
      return "services"
  }
}

function kindIcon(kind: Kind, ref: string): RowIcon {
  if (githubRef(kind, ref)) return "repository"
  return ({ file: "file", tree: "folder", env: "key", credential: "key", command: "command", port: "service" } as const)[kind]
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
  const size = leases.find((lease) => lease.delivery.size !== undefined)?.delivery.size
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

/**
 * Why a copy didn't land, as a fixed reason: the source's (`UnavailableReason`), or the borrower's own when it couldn't
 * place what it was given. Never a source's words, which can hold anything.
 */
export type SetupFailure = UnavailableReason | "disk-full"

const FAILURE_WORDS = {
  "not-found": "not at its source",
  outside: "outside its folder",
  unreadable: "couldn't be read",
  changed: "it changed while copying",
  "no-value": "nothing saved for it",
  error: "its source failed",
  "disk-full": "disk full",
} as const satisfies Record<SetupFailure, string>

/** A refusal as a copy that didn't land says it: by its reason, else by its code. */
function refusalWords(code: string, reason: SetupFailure | undefined): string {
  if (reason) return FAILURE_WORDS[reason]
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
      sync: shown === "lent" ? lentSync(grant, leases, broker, place) : grantSync(grant, leases, broker, place),
      origin: leases.length === 1 ? { from: "lease", lease: leases[0]!.id, grant: grant.id } : { from: "grant", grant: grant.id },
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

export function partSummary(part: SetupPartView, now: number): PartSummary {
  if (!part.rows.length) return { line: "Nothing yet", tone: "neutral" }
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
export function threadPlace(view: SetupView, place: string, thread: string, grants: readonly Grant[] = []): SetupPlaceView | undefined {
  const found = view.places.find((entry) => entry.id === place)
  if (!found) return undefined
  const others = new Set(grants.filter((grant) => grant.scope.level === "thread" && grant.scope.thread !== thread).map((grant) => grant.id))
  const asks = found.asks.filter((ask) => ask.by.thread === thread)
  const keepAsk = new Set(asks.map((ask) => ask.id))
  return {
    ...found,
    asks,
    parts: found.parts.map((part) => ({
      part: part.part,
      rows: part.rows.filter((row) => {
        if (row.origin.from === "ask") return keepAsk.has(row.origin.ask)
        if (row.origin.from === "grant" || row.origin.from === "lease") return !others.has(row.origin.grant)
        return true
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
export type SetupActOutcome = { done: true } | { done: false; why: string }

/** What an add in the Add menu is, by part: the menu's rows, in its order. */
export const SETUP_ADDITIONS = [
  { part: "files", title: "A file or folder from this Mac", detail: "Copied, or read live while the Mac is online" },
  { part: "access", title: "An account or secret", detail: "A service's token or an env value, by name; never shown again" },
  { part: "tools", title: "A tool", detail: "Added to the recipe's prepare, so every Thread has it" },
  { part: "code", title: "A repository to read", detail: "Another of the owner's, read-only" },
  { part: "services", title: "A service on your network", detail: "Reached through this Mac while it's online" },
] as const satisfies ReadonlyArray<{ part: SetupListPart; title: string; detail: string }>

/**
 * Where a browser away from the Mac reads a project's Setup, and acts on it: the account's broker answers both with the
 * same `SetupView` and `SetupActOutcome` a device's host does. `project` is the project's folder name.
 */
export const SETUP_PATHS = {
  view: (account: string, project: string) => `/v1/accounts/${encodeURIComponent(account)}/setup?project=${encodeURIComponent(project)}`,
  act: (account: string, project: string) => `/v1/accounts/${encodeURIComponent(account)}/setup/act?project=${encodeURIComponent(project)}`,
} as const
