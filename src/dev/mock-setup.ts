import type { Grant, Lease } from "@mako/protocol/borrow"
import { APEX_THREAD, APEX_TITLE } from "./mock-apex-thread"
import {
  grantForAnswer,
  setupView,
  type BrokerReading,
  type PlaceReading,
  type SetupAct,
  type SetupActOutcome,
  type SetupAsk,
  type SetupView,
} from "@mako/host/contracts/setup"

/**
 * A project's Setup for `?mock`: this Mac, the cloud and a Linux device named Studio, with what the account's broker
 * will serve (grants, leases, a copy that didn't land, two asks) as fixtures, derived by the same `setupView` the host
 * uses. Answers become grants, Send and Retry land a fresh lease, Stop ends what this Mac lends. The project's
 * repository is named for the folder read (`acme/<folder>`). `setup=quiet` starts with no asks; with `app=apex` the
 * asks are the open Apex's, on this Mac, so its side panel and composer show them.
 */
const ACCOUNT = "acct-fixture"
const MAC = "dev-mac"
const STUDIO = "dev-studio"
const MIN = 60_000
const HOUR = 60 * MIN

function borrower(thread: string, place: "cloud" | "mac" | "studio", repository = "acme/shop") {
  return {
    account: ACCOUNT,
    repository,
    thread,
    place: place === "cloud" ? ({ kind: "machine", machine: `m-${thread}` } as const) : ({ kind: "device", device: place === "mac" ? MAC : STUDIO } as const),
  }
}

function grant(id: string, partial: Partial<Grant> & Pick<Grant, "resource" | "source" | "mode">, at: number): Grant {
  return {
    id,
    scope: { level: "project", account: ACCOUNT, repository: "acme/shop" },
    access: partial.resource.kind === "command" || partial.resource.kind === "port" ? "run" : "read",
    lifetime: { until: "revoked" },
    ask: "never",
    secret: false,
    grantedBy: { kind: "person", account: ACCOUNT, device: MAC },
    grantedAt: at,
    version: 1,
    ...partial,
  }
}

function lease(id: string, of: Grant, thread: string, place: "cloud" | "mac" | "studio", at: number, extra: Partial<Lease> = {}): Lease {
  return {
    id,
    grant: of.id,
    grantVersion: of.version,
    borrower: borrower(thread, place),
    resource: of.resource,
    source: of.source,
    mode: of.mode,
    access: of.access,
    version: of.mode === "copy" ? "a".repeat(64) : `g${of.version}`,
    issuedAt: at,
    expiresAt: at + 24 * HOUR,
    delivery: { transfer: "none", secret: of.secret },
    ...extra,
  }
}

export function mockSetup() {
  const params = new URLSearchParams(globalThis.location?.search)
  const start = Date.now()
  const grants: Grant[] = [
    grant("g-pricing", { resource: { kind: "credential", ref: "github:acme/pricing" }, source: { kind: "mint", service: "github" }, mode: "minted" }, start - 6 * 24 * HOUR),
    grant("g-env", { resource: { kind: "file", ref: ".env.local" }, source: { kind: "device", device: MAC }, mode: "copy", secret: true, label: undefined }, start - 9 * 24 * HOUR),
    grant("g-config", { resource: { kind: "file", ref: "config/dev.local.json" }, source: { kind: "device", device: MAC }, mode: "copy" }, start - 9 * 24 * HOUR),
    grant("g-outreach", { resource: { kind: "tree", ref: "ignore/outreach" }, source: { kind: "device", device: MAC }, mode: "copy" }, start - 4 * 24 * HOUR),
    grant("g-notes", { resource: { kind: "tree", ref: "~/notes/pricing" }, source: { kind: "device", device: MAC }, mode: "live", ask: "first-use" }, start - 2 * 24 * HOUR),
    grant("g-deploy", { resource: { kind: "credential", ref: "deploy" }, source: { kind: "vault" }, mode: "copy", secret: true, label: "Deploy token", lifetime: { until: "expires", at: Date.UTC(2027, 0, 31) } }, start - 20 * 24 * HOUR),
    grant("g-role", { resource: { kind: "credential", ref: "cloud-role:ShopDeploy" }, source: { kind: "mint", service: "identity" }, mode: "minted", label: "Deploy role" }, start - 20 * 24 * HOUR),
    grant("g-db", { resource: { kind: "port", ref: "db.internal:5432" }, source: { kind: "device", device: MAC }, mode: "relay", ask: "first-use", label: "Staging database" }, start - 3 * 24 * HOUR),
    grant("g-prod-read", { resource: { kind: "command", ref: "infra --profile prod-readonly **" }, source: { kind: "device", device: MAC }, mode: "relay", ask: "each-use" }, start - 3 * 24 * HOUR),
  ]
  let leases: Lease[] = [
    lease("l-pricing", grants[0]!, "t-build", "cloud", start - 12 * MIN),
    lease("l-env", grants[1]!, "t-build", "cloud", start - 2 * 24 * HOUR, { version: "b".repeat(64), delivery: { transfer: "inline", secret: true, size: 412 } }),
    lease("l-config", grants[2]!, "t-build", "cloud", start - 2 * 24 * HOUR, { delivery: { transfer: "inline", secret: false, size: 2_048 } }),
    lease("l-outreach", grants[3]!, "t-build", "cloud", start - 1 * HOUR, { delivery: { transfer: "chunks", secret: false, size: 41 * 1024 * 1024 } }),
    lease("l-notes", grants[4]!, "t-build", "cloud", start - 3 * HOUR, { stale: { heldSince: start - 3 * HOUR, sourceLastSeen: start - 3 * HOUR } }),
    lease("l-deploy-1", grants[5]!, "t-build", "cloud", start - 40 * MIN),
    lease("l-deploy-2", grants[5]!, "t-pool", "cloud", start - 70 * MIN),
    lease("l-role", grants[6]!, "t-build", "cloud", start - 12 * MIN),
    lease("l-env-studio", grants[1]!, "t-studio", "studio", start - 3 * HOUR, { stale: { heldSince: start - 3 * HOUR, sourceLastSeen: start - 3 * HOUR } }),
    lease("l-notes-mac", grants[4]!, "t-build", "cloud", start - 25 * MIN),
  ]
  const refusals: BrokerReading["refusals"] = [
    { event: "refused", at: start - 3 * HOUR, grant: "g-outreach", borrower: borrower("t-studio", "studio"), resource: { kind: "tree", ref: "ignore/outreach" }, refused: "unavailable", reason: "unreadable", correlationId: "c-studio-outreach" },
  ]
  const apex = params.get("app") === "apex"
  // `?setup=long`: the asking Thread's title is its first message, as long as titles often are.
  const long = params.get("setup") === "long" ? "I'll read the MetaHarness track plan and the phone composer notes, then fix the webhook retries" : undefined
  const asker = (thread: string, title: string, harness: string, fin: boolean) => (apex ? { thread: APEX_THREAD, title: APEX_TITLE, harness: "claude", fin: false } : { thread, title: long ?? title, harness, fin })
  const askPlace = apex ? `device:${MAC}` : "cloud"
  let asks: SetupAsk[] =
    params.get("setup") === "quiet"
      ? []
      : [
          {
            id: "ask-ledger",
            kind: "borrow",
            answer: "grant",
            by: asker("t-build", "Shop build", "claude", false),
            at: start - 4 * MIN,
            why: "borrow the payout batching from the ledger service",
            place: askPlace,
            offer: {
              resource: { kind: "credential", ref: "github:acme/ledger" },
              borrower: borrower(apex ? APEX_THREAD : "t-build", apex ? "mac" : "cloud"),
              why: "borrow the payout batching from the ledger service",
              scope: { level: "thread", account: ACCOUNT, thread: apex ? APEX_THREAD : "t-build" },
              mode: "minted",
            },
          },
          { id: "ask-terraform", kind: "tool", tool: "terraform", version: "1.9", by: asker("t-pool", "Payout pool", "codex", true), at: start - 3 * MIN, why: "provision the database from infra/", place: askPlace },
        ]
  const devices: BrokerReading["devices"] = {
    [MAC]: { name: "MacBook Pro", platform: "mac", online: true, lastSeen: start },
    [STUDIO]: { name: "Studio", platform: "linux", online: false, lastSeen: start - 3 * HOUR },
  }
  const sourceVersions: BrokerReading["sourceVersions"] = { "g-env": "a".repeat(64) }
  const placeRows = (): PlaceReading[] => {
    const now = Date.now()
    return [
      {
        place: { kind: "device", device: MAC, name: "MacBook Pro", platform: "mac", here: true, online: true },
        checkout: "~/src/shop",
        rows: [
          { reading: "repository", part: "code", icon: "repository", name: "acme/shop", mono: true, detail: "The main checkout here; each Thread works on its own branch in a worktree", sync: { state: "synced", at: now - 5 * MIN } },
          { reading: "recipe-carry", part: "files", icon: "folder", name: "node_modules", mono: true, detail: "Linked to the main checkout while package-lock.json is the same", sync: { state: "here" } },
          { reading: "recipe-carry", part: "files", icon: "folder", name: "fixtures/recordings", mono: true, detail: "1.2 GB · linked between worktrees here, too large for the cloud", sync: { state: "here" } },
          { reading: "sign-in", part: "access", icon: "key", name: "Claude Code, Codex and Cursor", mono: false, detail: "Signed in on this device", scope: "account", sync: { state: "here" } },
          { reading: "saved-key", part: "access", icon: "key", name: "Local models key", mono: false, detail: "Saved in Settings › Models", scope: "account", sync: { state: "here" } },
          { reading: "recipe-prepare", part: "tools", icon: "tool", name: "npm ci", mono: true, detail: "The recipe's prepare · reruns after package-lock.json changes", sync: { state: "synced", at: now - HOUR } },
          { reading: "device-tools", part: "tools", icon: "tool", name: "terraform, go, infra", mono: true, detail: "On this Mac's PATH", sync: { state: "here" } },
          { reading: "recipe-process", part: "services", icon: "service", name: "web", mono: true, detail: "npm run dev · the Thread's first port", sync: { state: "here" } },
        ],
      },
      {
        place: { kind: "cloud" },
        base: { builtAt: now - 2 * HOUR, branch: "main", commit: "3f2a1c9e", tookMs: 72_000, bytes: 1.6 * 1024 ** 3 },
        rows: [
          { reading: "repository", part: "code", icon: "repository", name: "acme/shop", mono: true, detail: "Clones main, pushes its own branch, opens pull requests as Mako", sync: { state: "synced", at: now - 2 * HOUR } },
          { reading: "sign-in", part: "access", icon: "key", name: "Claude Code, Codex and Cursor", mono: false, detail: "Your sign-ins, kept fresh by Mako for every project", scope: "account", sync: { state: "synced", at: now - HOUR } },
          { reading: "carried-cloud", part: "access", icon: "key", name: "Payments key", mono: false, detail: "Your Mac's .env.local has PAYMENTS_SECRET_KEY; cloud Threads get no payments access", sync: { state: "missing" } },
          { reading: "image", part: "tools", icon: "tool", name: "From Mako's image", mono: false, detail: "Node 24 · pnpm 10 · Bun 1.4 · Python 3.11 · uv 0.13 · psql 15 · ripgrep · jq · and 24 more · mako-machine-aa02", sync: { state: "synced", at: now - 2 * HOUR } },
          { reading: "recipe-prepare", part: "tools", icon: "tool", name: "npm ci", mono: true, detail: "The recipe's prepare, baked into the base · node_modules 612 MB", sync: { state: "synced", at: now - 2 * HOUR } },
          { reading: "thread-tool", part: "tools", icon: "tool", name: "go 1.25", mono: true, detail: "Added by Shop build with mise; not in the setup, so the next Thread installs it again", sync: { state: "thread" } },
          { reading: "command-not-found", part: "tools", icon: "tool", name: "terraform", mono: true, detail: "2 Threads hit “command not found” today", sync: { state: "missing" } },
          { reading: "recipe-process", part: "services", icon: "service", name: "web", mono: true, detail: "npm run dev · the Thread's first port", sync: { state: "up", port: 20000 } },
        ],
      },
      {
        place: { kind: "device", device: STUDIO, name: "Studio", platform: "linux", here: false, online: false, lastSeen: now - 3 * HOUR, since: Date.UTC(2026, 9, 28) },
        rows: [
          { reading: "repository", part: "code", icon: "repository", name: "acme/shop", mono: true, detail: "~/src/shop · its own clone; worktrees for each Thread", sync: { state: "synced", at: now - 3 * HOUR } },
          { reading: "device-tools", part: "tools", icon: "tool", name: "Node 24", mono: false, detail: "Studio has Node 22, pnpm 9 and Python 3.12; this project's recipe asks for Node 24", sync: { state: "missing" } },
        ],
      },
    ]
  }
  const read = (folder: string): SetupView => {
    const now = Date.now()
    const name = folder.split("/").filter(Boolean).at(-1) ?? "shop"
    const repository = `acme/${name}`
    const ours = <T extends { borrower: { repository: string } }>(entry: T): T => ({ ...entry, borrower: { ...entry.borrower, repository } })
    const broker: BrokerReading = {
      account: ACCOUNT,
      grants: grants.map((entry) => (entry.scope.level === "project" ? { ...entry, scope: { ...entry.scope, repository } } : entry)),
      leases: leases.map(ours),
      refusals: refusals.map(ours),
      asks: asks.map((ask) => (ask.kind === "borrow" ? { ...ask, offer: { ...ask.offer, borrower: { ...ask.offer.borrower, repository } } } : ask)),
      sourceVersions,
      devices,
    }
    const places = placeRows().map((place) => ({ ...place, checkout: place.checkout?.replace("shop", name), rows: place.rows.map((row) => (row.reading === "repository" ? { ...row, name: repository, detail: row.detail.replace("shop", name) } : row)) }))
    return setupView({ now, project: { name, root: folder, repository }, places, broker, threads: ["t-build", "t-pool", "t-studio", APEX_THREAD] })
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 350))
  return {
    setup: async (folder: string) => read(folder),
    setupAct: async (folder: string, act: SetupAct): Promise<SetupActOutcome> => {
      await settle()
      const now = Date.now()
      if (act.act === "rebuild") return { done: true }
      if (act.act === "answer") {
        const ask = asks.find((entry) => entry.id === act.ask)
        if (!ask) return { done: false, why: "That ask was answered already." }
        asks = asks.filter((entry) => entry.id !== act.ask)
        const made = grantForAnswer(ask, act.answer, { id: `g-${ask.id}`, account: ACCOUNT, source: { kind: "vault" }, device: MAC, at: now })
        if (made && ask.kind === "borrow") {
          grants.push(made)
          leases = [...leases, lease(`l-${ask.id}`, made, ask.by.thread, apex ? "mac" : "cloud", now)]
        }
        return { done: true }
      }
      const view = read(folder)
      const row = view.places.find((place) => place.id === act.place)?.parts.flatMap((part) => part.rows).find((entry) => entry.id === act.row)
      if (!row || row.origin.from === "reading" || row.origin.from === "ask") return { done: false, why: "That needs the account's broker." }
      const { grant: grantId } = row.origin
      if (act.action === "stop") {
        const index = grants.findIndex((entry) => entry.id === grantId)
        if (index >= 0) grants.splice(index, 1)
        leases = leases.filter((entry) => entry.grant !== grantId)
        return { done: true }
      }
      const index = refusals.findIndex((event) => event.grant === grantId)
      if (index >= 0) refusals.splice(index, 1)
      leases = leases.map((entry) => {
        if (entry.grant !== grantId) return entry
        const fresh: Lease = { ...entry, version: sourceVersions[grantId] ?? entry.version, issuedAt: now }
        delete fresh.stale
        return fresh
      })
      if (!leases.some((entry) => entry.grant === grantId)) {
        const held = grants.find((entry) => entry.id === grantId)
        if (held) leases = [...leases, lease(`l-${grantId}-${now}`, held, "t-studio", act.place === "cloud" ? "cloud" : "studio", now)]
      }
      return { done: true }
    },
  }
}
