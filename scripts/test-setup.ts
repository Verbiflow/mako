/**
 * Setup's rows and words (`@mako/host/contracts/setup`): every state said in words with one tone and its one button,
 * the six parts in their order, each grant and lease placed in its part and stated against its source (synced, newer,
 * a stale copy, a copy that didn't land, offline), what a device lends with Stop, asks in Needs you and in their part,
 * the grant an answer makes, a Thread's own place, the phone's one-line parts, and a place's own readings (the
 * recipe's carry, the cloud's carried files, sign-ins). No row carries a value or a content hash.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Grant, Lease } from "@mako/protocol/borrow"
import {
  age,
  askAnswerLabel,
  askAnswers,
  bytes,
  grantForAnswer,
  partSummary,
  askLine,
  rowAction,
  sourceAskOf,
  SETUP_LIST_PARTS,
  SETUP_PARTS,
  setupView,
  syncWords,
  threadPlace,
  type BrokerReading,
  type PlaceReading,
  type SetupAsk,
  type SetupPlace,
  type SetupPlaceView,
  type SetupRow,
  type SyncState,
} from "@mako/host/contracts/setup"
import { carriedCloudRows, carryRows, cloudSignInRows, processRows } from "@mako/host/contracts/setup-readings"
import type { RecipeView } from "@mako/host/contracts/project-app"

const NOW = Date.UTC(2026, 10, 4, 12)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ACCOUNT = "acct"
const MAC = "mac-1"
const STUDIO = "studio-1"
const REPO = "acme/shop"
const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

const mac: SetupPlace = { kind: "device", device: MAC, name: "MacBook Pro", platform: "mac", here: true, online: true }
const studio: SetupPlace = { kind: "device", device: STUDIO, name: "Studio", platform: "linux", here: false, online: false, lastSeen: NOW - 3 * HOUR }
const cloud: SetupPlace = { kind: "cloud" }

function grant(id: string, partial: Partial<Grant> & Pick<Grant, "resource" | "source" | "mode">): Grant {
  return {
    id,
    scope: { level: "project", account: ACCOUNT, repository: REPO },
    access: partial.resource.kind === "command" || partial.resource.kind === "port" ? "run" : "read",
    lifetime: { until: "revoked" },
    ask: "never",
    secret: false,
    grantedBy: { kind: "person", account: ACCOUNT },
    grantedAt: NOW - 9 * DAY,
    version: 1,
    ...partial,
  }
}

function lease(id: string, of: Grant, thread: string, where: "cloud" | "studio" | "mac", at: number, extra: Partial<Lease> = {}): Lease {
  return {
    id,
    grant: of.id,
    grantVersion: of.version,
    borrower: { account: ACCOUNT, repository: REPO, thread, place: where === "cloud" ? { kind: "machine", machine: `m-${thread}` } : { kind: "device", device: where === "mac" ? MAC : STUDIO } },
    resource: of.resource,
    source: of.source,
    mode: of.mode,
    access: of.access,
    version: of.mode === "copy" ? HASH_A : `g${of.version}`,
    issuedAt: at,
    expiresAt: at + DAY,
    delivery: { transfer: "none", secret: of.secret },
    ...extra,
  }
}

const env = grant("g-env", { resource: { kind: "file", ref: ".env.local" }, source: { kind: "device", device: MAC }, mode: "copy", secret: true })
const config = grant("g-config", { resource: { kind: "file", ref: "config/dev.json" }, source: { kind: "device", device: MAC }, mode: "copy" })
const outreach = grant("g-outreach", { resource: { kind: "tree", ref: "ignore/outreach" }, source: { kind: "device", device: MAC }, mode: "copy" })
const notes = grant("g-notes", { resource: { kind: "tree", ref: "~/notes" }, source: { kind: "device", device: MAC }, mode: "live", ask: "first-use" })
const pricing = grant("g-pricing", { resource: { kind: "credential", ref: "github:acme/pricing" }, source: { kind: "mint", service: "github" }, mode: "minted" })
const deploy = grant("g-deploy", { resource: { kind: "credential", ref: "deploy" }, source: { kind: "vault" }, mode: "copy", secret: true, label: "Deploy token", lifetime: { until: "expires", at: Date.UTC(2027, 0, 31) } })
const db = grant("g-db", { resource: { kind: "port", ref: "db.internal:5432" }, source: { kind: "device", device: STUDIO }, mode: "relay", ask: "first-use", label: "Staging database" })
const infra = grant("g-infra", { resource: { kind: "command", ref: "infra plan **" }, source: { kind: "device", device: MAC }, mode: "relay", ask: "each-use" })
const local = grant("g-local", { resource: { kind: "tree", ref: "fixtures/recordings" }, source: { kind: "device", device: MAC }, mode: "live", within: "source-device" })
const elsewhere = grant("g-other", { resource: { kind: "file", ref: ".env" }, source: { kind: "vault" }, mode: "copy", scope: { level: "project", account: ACCOUNT, repository: "acme/other" } })
const otherThread = grant("g-other-thread", { resource: { kind: "file", ref: "notes.md" }, source: { kind: "vault" }, mode: "copy", scope: { level: "thread", account: ACCOUNT, thread: "t-unknown" }, lifetime: { until: "thread-ends" } })
const mine = grant("g-mine", { resource: { kind: "file", ref: "scratch.md" }, source: { kind: "vault" }, mode: "copy", scope: { level: "thread", account: ACCOUNT, thread: "t-pool" }, lifetime: { until: "thread-ends" } })

const ask: SetupAsk = {
  id: "ask-ledger",
  kind: "borrow",
  answer: "grant",
  by: { thread: "t-build", title: "Shop build", harness: "claude", fin: false },
  at: NOW - 4 * MIN,
  why: "borrow the payout batching",
  place: "cloud",
  offer: {
    resource: { kind: "credential", ref: "github:acme/ledger" },
    borrower: { account: ACCOUNT, repository: REPO, thread: "t-build", place: { kind: "machine", machine: "m-t-build" } },
    why: "borrow the payout batching",
    scope: { level: "thread", account: ACCOUNT, thread: "t-build" },
    mode: "minted",
  },
}
const toolAsk: SetupAsk = { id: "ask-tf", kind: "tool", tool: "terraform", version: "1.9", by: { thread: "t-pool", title: "Payout pool", harness: "codex", fin: true }, at: NOW - 3 * MIN, why: "provision the database", place: "cloud" }

function broker(extra: Partial<BrokerReading> = {}): BrokerReading {
  return {
    account: ACCOUNT,
    grants: [env, config, outreach, notes, pricing, deploy, db, infra, local, elsewhere, otherThread, mine],
    leases: [
      lease("l-env", env, "t-build", "cloud", NOW - 2 * DAY, { version: HASH_B, delivery: { transfer: "inline", secret: true, size: 412 } }),
      lease("l-config", config, "t-build", "cloud", NOW - 2 * DAY, { delivery: { transfer: "inline", secret: false, size: 2_048 } }),
      lease("l-notes", notes, "t-build", "cloud", NOW - 3 * HOUR, { stale: { heldSince: NOW - 3 * HOUR, sourceLastSeen: NOW - 3 * HOUR } }),
      lease("l-pricing", pricing, "t-build", "cloud", NOW - 12 * MIN),
      lease("l-deploy-1", deploy, "t-build", "cloud", NOW - 40 * MIN),
      lease("l-deploy-2", deploy, "t-pool", "cloud", NOW - 70 * MIN),
      lease("l-env-studio", env, "t-studio", "studio", NOW - 3 * HOUR, { stale: { heldSince: NOW - 3 * HOUR, sourceLastSeen: NOW - 3 * HOUR } }),
    ],
    refusals: [
      { event: "refused", at: NOW - 3 * HOUR, grant: outreach.id, borrower: { account: ACCOUNT, repository: REPO, thread: "t-studio", place: { kind: "device", device: STUDIO } }, resource: outreach.resource, refused: "unavailable", reason: "unreadable", correlationId: "c1" },
    ],
    asks: [ask, toolAsk],
    sourceVersions: { [env.id]: HASH_A },
    devices: {
      [MAC]: { name: "MacBook Pro", platform: "mac", online: true, lastSeen: NOW },
      [STUDIO]: { name: "Studio", platform: "linux", online: false, lastSeen: NOW - 3 * HOUR },
    },
    ...extra,
  }
}

const readings = (): PlaceReading[] => [
  {
    place: mac,
    checkout: "~/src/shop",
    rows: [
      { reading: "repository", part: "code", icon: "repository", name: REPO, mono: true, detail: "The main checkout here", sync: { state: "synced", at: NOW } },
      { reading: "recipe-carry", part: "files", icon: "file", name: ".env.local", mono: true, detail: "Copied into each new worktree", sync: { state: "synced", at: NOW - HOUR } },
    ],
  },
  { place: cloud, base: { builtAt: NOW - 2 * HOUR, branch: "main", commit: "3f2a1c9e", tookMs: 72_000, bytes: 1.6 * 1024 ** 3 }, rows: [{ reading: "image", part: "tools", icon: "tool", name: "From Mako's image", mono: false, detail: "Node 24", sync: { state: "synced", at: NOW - 2 * HOUR } }] },
  { place: studio, rows: [] },
]

const view = () => setupView({ now: NOW, project: { name: "shop", root: "/work/shop", repository: REPO }, places: readings(), broker: broker(), threads: ["t-build", "t-pool", "t-studio"] })
const placeOf = (id: string) => view().places.find((place) => place.id === id)!
const rows = (place: SetupPlaceView) => place.parts.flatMap((part) => part.rows)
const named = (place: SetupPlaceView, name: string): SetupRow => {
  const found = rows(place).find((row) => row.name === name)
  assert.ok(found, `${place.id} has ${name}: ${rows(place).map((row) => row.name).join(", ")}`)
  return found
}
const said = (row: SetupRow) => syncWords(row.sync, NOW).words

test("every state is said in words, with one tone and at most one button", () => {
  const cases: Array<[SyncState, string, string, string | undefined]> = [
    [{ state: "synced", at: NOW - 2 * DAY }, "Synced 2 d ago", "positive", undefined],
    [{ state: "synced", at: NOW - 20_000 }, "Synced just now", "positive", undefined],
    [{ state: "newer", source: "Mac's" }, "Mac's is newer", "caution", "send"],
    [{ state: "stale", since: NOW - 3 * HOUR }, "Copy · 3 h old", "caution", undefined],
    [{ state: "asked" }, "Waiting on you", "attention", undefined],
    [{ state: "missing" }, "Not here", "negative", "add"],
    [{ state: "failed", why: "couldn't be read" }, "Didn't copy: couldn't be read", "negative", "retry"],
    [{ state: "here" }, "Stays here", "neutral", undefined],
    [{ state: "thread" }, "This Thread only", "neutral", "keep"],
    [{ state: "up", port: 20000 }, "Up on 20000", "positive", undefined],
    [{ state: "offline", through: "MacBook Pro" }, "MacBook Pro offline", "caution", undefined],
  ]
  for (const [sync, words, tone, action] of cases) {
    const result = syncWords(sync, NOW)
    assert.equal(result.words, words)
    assert.equal(result.tone, tone)
    assert.equal(result.action, action)
  }
  // Two states of one tone never share words: the dot's colour is never all a row says.
  const byTone = new Map<string, Set<string>>()
  for (const [sync] of cases) {
    const result = syncWords(sync, NOW)
    const seen = byTone.get(result.tone) ?? new Set()
    assert.ok(!seen.has(result.words))
    seen.add(result.words)
    byTone.set(result.tone, seen)
  }
})

test("ages and sizes read short", () => {
  assert.equal(age(30_000), "just now")
  assert.equal(age(12 * MIN), "12 min")
  assert.equal(age(3 * HOUR + 59 * MIN), "3 h")
  assert.equal(age(49 * HOUR), "2 d")
  assert.equal(bytes(2_048), "2 KB")
  assert.equal(bytes(41 * 1024 * 1024), "41 MB")
  assert.equal(bytes(1.6 * 1024 ** 3), "1.6 GB")
})

test("places come this device first, then the cloud, then the others; each has the five list parts in order", () => {
  assert.deepEqual(SETUP_PARTS, ["needs", "code", "files", "access", "tools", "services"])
  const places = view().places
  assert.deepEqual(places.map((place) => place.id), [`device:${MAC}`, "cloud", `device:${STUDIO}`])
  for (const place of places) assert.deepEqual(place.parts.map((part) => part.part), SETUP_LIST_PARTS)
  assert.match(places[1]!.line, /^Each Thread gets a machine of its own, started from this project's base: built 2 h ago from main 3f2a1c in 1 min 12 s, 1.6 GB\.$/)
  assert.match(places[0]!.line, /worktrees of ~\/src\/shop/)
  assert.match(places[2]!.line, /Last online 3 h ago/)
})

test("each grant lands in its kind's part, said against its source at the place", () => {
  const atCloud = placeOf("cloud")
  const part = (name: string) => named(atCloud, name).part
  assert.equal(part("acme/pricing"), "code")
  assert.equal(part(".env.local"), "files")
  assert.equal(part("~/notes"), "files")
  assert.equal(part("Deploy token"), "access")
  assert.equal(part("infra plan **"), "tools")
  assert.equal(part("Staging database"), "services")

  // The Mac's copy moved on since the cloud's lease: Send.
  assert.equal(said(named(atCloud, ".env.local")), "Mac's is newer")
  assert.equal(rowAction(named(atCloud, ".env.local"), NOW), "send")
  assert.equal(said(named(atCloud, "config/dev.json")), "Synced 2 d ago")
  assert.equal(said(named(atCloud, "~/notes")), "Copy · 3 h old")
  assert.equal(said(named(atCloud, "acme/pricing")), "Synced 12 min ago")
  // Two Threads' leases: the newest says when.
  assert.equal(said(named(atCloud, "Deploy token")), "Synced 40 min ago")
  // A relay through a device that's offline says so.
  assert.equal(said(named(atCloud, "Staging database")), "Studio offline")

  const deployRow = named(atCloud, "Deploy token")
  assert.equal(deployRow.scope, "project")
  assert.match(deployRow.detail, /Kept encrypted in your account · agents see names only · lapses Jan 31/)
  assert.match(named(atCloud, "acme/pricing").detail, /From Mako's GitHub app, an hour at a time, nothing stored · read-only/)
  assert.match(named(atCloud, "config/dev.json").detail, /A copy from MacBook Pro · read-only · 2 KB/)
  assert.match(named(atCloud, "infra plan **").detail, /Runs on MacBook Pro, output sent back · asks each time/)
})

test("what a grant doesn't reach stays off the page", () => {
  const atCloud = placeOf("cloud")
  const names = rows(atCloud).map((row) => row.name)
  assert.ok(!names.includes("fixtures/recordings"), "a grant kept to its source device isn't the cloud's")
  assert.ok(!names.includes(".env"), "another project's grant")
  assert.ok(!names.includes("notes.md"), "a grant of a Thread outside the project")
  assert.ok(names.includes("scratch.md"), "a grant of one of the project's Threads")
})

test("another device shows only what reached it or failed to", () => {
  const atStudio = placeOf(`device:${STUDIO}`)
  assert.equal(said(named(atStudio, ".env.local")), "Copy · 3 h old")
  const failed = named(atStudio, "ignore/outreach")
  assert.equal(said(failed), "Didn't copy: couldn't be read")
  assert.equal(rowAction(failed, NOW), "retry")
  const names = rows(atStudio).map((row) => row.name)
  assert.ok(!names.includes("Deploy token"))
  assert.ok(!names.includes("acme/pricing"))
})

test("the source device lists what it lends, with Stop, or Send where its own copy moved on", () => {
  const atMac = placeOf(`device:${MAC}`)
  const lentNotes = named(atMac, "~/notes")
  assert.equal(rowAction(lentNotes, NOW), "stop")
  assert.match(lentNotes.detail, /^Lent to Threads elsewhere while this device is online|^Read by 1 Thread elsewhere/)
  const lentEnv = rows(atMac).filter((row) => row.name === ".env.local" && row.origin.from !== "reading")
  assert.equal(lentEnv.length, 1)
  assert.equal(rowAction(lentEnv[0]!, NOW), "send")
  // A grant kept to its source device is the device's own, held, never lent, and the person can stop it here.
  const kept = named(atMac, "fixtures/recordings")
  assert.equal(kept.action, "stop")
  assert.ok(!/Read by|Lent/.test(kept.detail))
  // A Studio-sourced relay isn't the Mac's to lend, and nothing reached the Mac under it.
  assert.ok(!rows(atMac).some((row) => row.name === "Staging database"))
})

test("this device's own brokers: a pattern grant lists each entry taken, for this project's worktrees alone", () => {
  const LOCAL = "this-device"
  const here: SetupPlace = { kind: "device", device: LOCAL, name: "MacBook Pro", platform: "mac", here: true, online: true }
  const copies = grant("device-checkouts-copy", { resource: { kind: "tree", ref: "**" }, source: { kind: "device", device: LOCAL }, mode: "copy", scope: { level: "account", account: ACCOUNT }, within: "source-device", label: "Files Git ignores, copied into worktrees" })
  const local = (id: string, ref: string, thread: string, repository: string): Lease => ({
    ...lease(id, copies, thread, "mac", NOW - HOUR),
    resource: { kind: "file", ref },
    borrower: { account: ACCOUNT, repository, thread, place: { kind: "device", device: LOCAL } },
  })
  const page = setupView({
    now: NOW,
    project: { name: "shop", root: "/work/shop", repository: REPO },
    places: [{ place: here, rows: [{ reading: "recipe-carry", part: "files", icon: "file", name: ".env.local", mono: true, detail: "Copied into each new worktree", sync: { state: "synced", at: NOW - DAY } }] }],
    broker: {
      ...broker({ grants: [copies], leases: [local("a", ".env.local", "t1", "/work/shop"), local("b", ".env.local", "t2", "/work/shop"), local("c", "secret.json", "t3", "/work/other")], asks: [], refusals: [] }),
      devices: { [LOCAL]: { name: "MacBook Pro", platform: "mac", online: true, lastSeen: NOW } },
    },
  }).places[0]!
  const names = rows(page).map((row) => row.name)
  assert.deepEqual(names, ["Files Git ignores, copied into worktrees", ".env.local"])
  const entry = named(page, ".env.local")
  assert.equal(entry.origin.from, "lease")
  assert.equal(entry.detail, "Copied into 2 Threads' worktrees")
  assert.equal(said(entry), "Synced 1 h ago")
  assert.equal(rowAction(named(page, "Files Git ignores, copied into worktrees"), NOW), "stop")
})

test("a source's ask of this device's person waits in Needs you, answered for its Thread or declined", () => {
  const waiting = {
    at: NOW - 2 * MIN,
    ask: {
      ask: "src-1",
      grant: notes.id,
      resource: notes.resource,
      ref: "~/notes/plan.md",
      mode: "live" as const,
      borrower: { account: ACCOUNT, repository: REPO, thread: "t-build", place: { kind: "machine" as const, machine: "m-1" } },
      why: "read the pricing notes",
      askPerson: true,
    },
  }
  const asked = sourceAskOf(waiting, "cloud", { thread: "t-build", title: "Shop build", fin: false })
  assert.equal(asked.kind === "borrow" && asked.answer, "source")
  assert.deepEqual(askAnswers(asked), ["allow-thread", "decline"])
  assert.equal(askLine(asked).thing, "~/notes/plan.md")
  const page = setupView({ now: NOW, project: { name: "shop", root: "/work/shop", repository: REPO }, places: readings(), broker: broker({ asks: [asked] }), threads: ["t-build"] })
  const atCloud = page.places.find((place) => place.id === "cloud")!
  assert.deepEqual(atCloud.asks.map((entry) => entry.id), ["src-1"])
  assert.equal(said(rows(atCloud).find((row) => row.origin.from === "ask")!), "Waiting on you")
})

test("a grant's row takes the place of a reading of the same thing", () => {
  const cloudRows = setupView({
    now: NOW,
    project: { name: "shop", root: "/work/shop", repository: REPO },
    places: [{ place: cloud, rows: [{ reading: "carried-cloud", part: "files", icon: "file", name: "config/dev.json", mono: true, detail: "From MacBook Pro", sync: { state: "missing" } }] }],
    broker: broker(),
  }).places[0]!
  const matches = rows(cloudRows).filter((row) => row.name === "config/dev.json")
  assert.equal(matches.length, 1)
  assert.equal(matches[0]!.origin.from, "lease")
})

test("asks wait in Needs you and in their own part, answered with the narrowest reach first", () => {
  const atCloud = placeOf("cloud")
  assert.deepEqual(atCloud.asks.map((entry) => entry.id), ["ask-ledger", "ask-tf"])
  assert.equal(placeOf(`device:${MAC}`).asks.length, 0)
  const asked = named(atCloud, "acme/ledger")
  assert.equal(asked.part, "code")
  assert.equal(said(asked), "Waiting on you")
  assert.match(asked.detail, /^Asked for by Shop build, 4 min ago$/)
  assert.equal(named(atCloud, "terraform").part, "tools")

  assert.deepEqual(askAnswers(ask), ["allow-thread", "allow-project", "decline"])
  assert.deepEqual(askAnswers(toolAsk), ["add-to-setup", "decline"])
  assert.equal(askAnswerLabel(ask, "allow-thread"), "Allow for this Thread")
  assert.equal(askAnswerLabel(ask, "allow-project", true), "For the project")
  assert.equal(askAnswerLabel(toolAsk, "add-to-setup"), "Add terraform 1.9 to setup")
  assert.equal(askAnswerLabel(toolAsk, "add-to-setup", true), "Add to setup")
})

test("an answer makes the grant the person chose, and Decline makes none", () => {
  const made = { id: "g-new", account: ACCOUNT, source: { kind: "vault" } as const, at: NOW }
  const thread = grantForAnswer(ask, "allow-thread", made)!
  assert.deepEqual(thread.scope, { level: "thread", account: ACCOUNT, thread: "t-build" })
  assert.deepEqual(thread.lifetime, { until: "thread-ends" })
  assert.deepEqual(thread.source, { kind: "mint", service: "github" }, "a repository is always minted")
  assert.equal(thread.grantedBy.kind, "person")
  const project = grantForAnswer(ask, "allow-project", made)!
  assert.deepEqual(project.scope, { level: "project", account: ACCOUNT, repository: REPO })
  assert.deepEqual(project.lifetime, { until: "revoked" })
  assert.equal(grantForAnswer(ask, "decline", made), undefined)
  assert.equal(grantForAnswer(toolAsk, "add-to-setup", made), undefined)
  const file: SetupAsk = { ...ask, offer: { ...ask.offer, resource: { kind: "file", ref: "~/notes/a.md" }, mode: "copy" } }
  const fromMac = grantForAnswer(file, "allow-project", { ...made, source: { kind: "device", device: MAC } })!
  assert.equal(fromMac.ask, "first-use", "a device's grant asks it the first time")
  assert.equal(fromMac.access, "read")
})

test("a Thread's own place keeps its own asks and leaves out other Threads' grants", () => {
  const whole = view()
  const own = threadPlace(whole, "cloud", "t-pool", broker().grants)!
  assert.deepEqual(own.asks.map((entry) => entry.id), ["ask-tf"])
  assert.ok(rows(own).some((row) => row.name === "terraform"))
  assert.ok(!rows(own).some((row) => row.name === "acme/ledger"))
  assert.ok(rows(own).some((row) => row.name === "scratch.md"))
  const build = threadPlace(whole, "cloud", "t-build", broker().grants)!
  assert.ok(!rows(build).some((row) => row.name === "scratch.md"))
})

test("a part folds to one line led by what needs a look", () => {
  const atCloud = placeOf("cloud")
  const code = atCloud.parts.find((part) => part.part === "code")!
  assert.deepEqual(partSummary(code, NOW), { line: "acme/ledger: waiting on you · acme/pricing", tone: "attention" })
  const files = atCloud.parts.find((part) => part.part === "files")!
  assert.equal(partSummary(files, NOW).tone, "caution")
  assert.match(partSummary(files, NOW).line, /^\.env\.local: mac's is newer · /)
  assert.deepEqual(partSummary({ part: "services", rows: [] }, NOW), { line: "Nothing yet", tone: "neutral" })
})

test("no row carries a value or a content hash", () => {
  const page = JSON.stringify(view())
  assert.ok(!page.includes(HASH_A) && !page.includes(HASH_B))
})

test("the recipe's carry, the cloud's carried files and sign-ins read as rows", () => {
  const recipe: RecipeView = {
    values: {},
    processes: [{ name: "web", command: "npm run dev", port: "{port}" }],
    checks: {},
    prepare: [],
    carry: [
      { path: ".env.local", link: false, credentials: true },
      { path: "node_modules", link: true, credentials: false },
      { path: "config/missing.json", link: false, credentials: false },
    ],
    oneAtATime: false,
  }
  const carried = carryRows(recipe, new Map([[".env.local", { at: NOW - HOUR, size: 412 }], ["node_modules", { at: NOW - DAY }]]))
  assert.deepEqual(carried.map((row) => [row.name, syncWords(row.sync, NOW).words]), [
    [".env.local", "Synced 1 h ago"],
    ["node_modules", "Stays here"],
    ["config/missing.json", "Not here"],
  ])
  assert.match(carried[0]!.detail, /412 B · agents are told never to open it/)

  const cloudFiles = carriedCloudRows(
    {
      project: "/work/shop",
      repository: "https://github.com/acme/shop",
      decision: "allowed",
      files: [
        { path: ".env.local", bytes: 412, credentials: true, cloud: { savedAt: new Date(NOW - DAY).toISOString(), current: false }, kept: false },
        { path: "config/dev.json", bytes: 2_048, credentials: false, cloud: { savedAt: new Date(NOW - 2 * DAY).toISOString(), current: true }, kept: false },
        { path: "keys.pem", bytes: 90, credentials: true, cloud: null, kept: true },
      ],
      staying: [{ path: "fixtures", why: "linked to the main folder, not copied" }],
    },
    "MacBook Pro"
  )
  assert.deepEqual(cloudFiles.map((row) => syncWords(row.sync, NOW).words), ["Mac's is newer", "Synced 2 d ago", "Stays here", "Stays here"])
  const unasked = carriedCloudRows({ project: "/w", repository: "https://github.com/acme/shop", decision: "unasked", files: [{ path: ".env", bytes: 1, credentials: true, cloud: null, kept: false }], staying: [] }, "MacBook Pro")
  assert.equal(syncWords(unasked[0]!.sync, NOW).words, "Not here")

  assert.deepEqual(cloudSignInRows({ sharing: false, harnesses: [] }, (harness) => harness).map((row) => [row.name, row.target, syncWords(row.sync, NOW).words]), [["Your sign-ins", "share-sign-ins", "Not here"]])
  const shared = cloudSignInRows(
    { sharing: true, checkedAt: new Date(NOW - HOUR).toISOString(), harnesses: [{ harness: "claude", status: "sent", label: null, expiresAt: null, sentAt: new Date(NOW - HOUR).toISOString() }, { harness: "codex", status: "failed", label: null, expiresAt: null, problem: "expired" }] },
    (harness) => ({ claude: "Claude Code", codex: "Codex" })[harness] ?? harness
  )
  assert.deepEqual(shared.map((row) => [row.name, syncWords(row.sync, NOW).words]), [["Claude Code", "Synced 1 h ago"], ["Codex", "Didn't copy: expired"]])

  const services = processRows(recipe, cloud, NOW, new Map([["web", 20000]]))
  assert.equal(syncWords(services[0]!.sync, NOW).words, "Up on 20000")
  assert.match(services[0]!.detail, /npm run dev · the Thread's first port/)
})

test("the host reads this device's place and the cloud's from what it holds, and Send copies a carried file again", async () => {
  const { mkdtemp, rm, writeFile, mkdir, utimes } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { SetupViews } = await import("@mako/host/workspaces/setup-view")
  const root = await mkdtemp(join(tmpdir(), "mako-setup-"))
  try {
    await writeFile(join(root, ".env.local"), "NAME=never-read\n")
    await utimes(join(root, ".env.local"), (NOW - HOUR) / 1000, (NOW - HOUR) / 1000)
    await mkdir(join(root, "node_modules"))
    const kept: Array<[string, boolean]> = []
    const carriedView = {
      project: root,
      repository: "https://github.com/acme/shop",
      decision: "allowed" as const,
      files: [{ path: ".env.local", bytes: 16, credentials: true, cloud: { savedAt: new Date(NOW - DAY).toISOString(), current: false }, kept: false }],
      staying: [],
    }
    const views = new SetupViews({
      now: () => NOW,
      recipe: async () => ({
        project: "shop",
        root,
        recipe: {
          kind: "ready",
          source: "mako",
          file: join(root, "recipe.json"),
          savedAt: NOW - DAY,
          earlier: 0,
          versions: [],
          recipe: {
            values: {},
            processes: [{ name: "web", command: "npm run dev", port: "{port}" }],
            checks: {},
            prepare: [{ command: "npm ci", inputs: ["package-lock.json"], outputs: ["**/node_modules"], link: true }],
            carry: [
              { path: ".env.local", link: false, credentials: true },
              { path: "node_modules", link: true, credentials: false },
              { path: "config/dev.json", link: false, credentials: false },
            ],
            oneAtATime: false,
          },
        },
      }),
      carried: {
        view: async () => carriedView,
        decide: async () => carriedView,
        keep: async (_folder, path, keep) => {
          kept.push([path, keep])
          return carriedView
        },
      },
      cloudSignIns: { state: async () => ({ sharing: false, harnesses: [] }), share: async () => undefined },
      accounts: async () => ({ providers: [], accounts: [{ harness: "claude", name: "work", dir: "/x", active: true }] }),
      keys: async () => ({ connections: [], issues: [], secureStorage: true, harnesses: [] }),
      device: async () => ({ id: "mac-1", name: "MacBook Pro" }),
      label: (harness) => (harness === "claude" ? "Claude Code" : harness),
    })
    const page = await views.view(root)
    assert.deepEqual(page.places.map((place) => place.id), ["device:this-device", "cloud"])
    const [here, there] = page.places
    const words = (place: SetupPlaceView) => Object.fromEntries(rows(place).map((row) => [row.name, syncWords(row.sync, NOW).words]))
    assert.deepEqual(words(here!), {
      "acme/shop": "Synced just now",
      ".env.local": "Synced 1 h ago",
      node_modules: "Stays here",
      "config/dev.json": "Not here",
      "Claude Code": "Stays here",
      "npm ci": "Synced 1 d ago",
      web: "Stays here",
    })
    assert.equal(words(there!)[".env.local"], "Mac's is newer")
    assert.equal(words(there!)["Your sign-ins"], "Not here")
    assert.ok(!JSON.stringify(page).includes("never-read"), "a file's contents never reach the page")
    const send = rows(there!).find((row) => row.name === ".env.local")!
    assert.deepEqual(await views.act(root, { act: "row", place: "cloud", row: send.id, action: "send" }), { done: true })
    assert.deepEqual(kept, [[".env.local", false]])
    const answered = await views.act(root, { act: "answer", ask: "a", answer: "decline" })
    assert.equal(answered.done, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the host reads this device's own brokers and the account's, and answers and stops where each is kept", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { SetupViews } = await import("@mako/host/workspaces/setup-view")
  const { LocalBorrowing } = await import("@mako/host/base/local-borrowing")
  const { CHECKOUT_SOURCES, LOCAL_DEVICE, checkoutGrants } = await import("@mako/host/workspaces/checkout-borrowing")
  const { GrantedSecrets } = await import("@mako/host/base/secret-grants")
  const { memorySecrets } = await import("@mako/host/base/secrets")
  const root = await mkdtemp(join(tmpdir(), "mako-setup-brokers-"))
  try {
    await writeFile(join(root, ".env.local"), "NAME=never-read\n")
    await writeFile(join(root, "notes.md"), "# notes\n")
    const checkouts = new LocalBorrowing({ device: LOCAL_DEVICE, account: "local", sources: CHECKOUT_SOURCES })
    for (const seeded of checkoutGrants(LOCAL_DEVICE, "local", NOW - DAY)) await checkouts.grant(seeded)
    await checkouts.grant({
      id: "g-notes-first",
      resource: { kind: "file", ref: "notes.md" },
      source: { kind: "device", device: LOCAL_DEVICE },
      scope: { level: "thread", account: "local", thread: "t-2" },
      within: "source-device",
      mode: "copy",
      access: "read",
      lifetime: { until: "revoked" },
      ask: "first-use",
      secret: false,
      grantedBy: { kind: "person", account: "local" },
      grantedAt: NOW - DAY,
      version: 1,
    })
    const borrower = { account: "local", repository: root, thread: "t-1", place: { kind: "device" as const, device: LOCAL_DEVICE } }
    const copied = await checkouts.borrow({ kind: "file", ref: ".env.local", for: borrower, why: "the recipe's carry", correlationId: "c-env", mode: "copy" })
    assert.ok("lease" in copied)
    const waiting = await checkouts.borrow({ kind: "file", ref: "notes.md", for: { ...borrower, thread: "t-2" }, why: "read the notes", correlationId: "c-notes" })
    assert.ok("pending" in waiting)
    const saved = new GrantedSecrets(memorySecrets())
    await saved.write("saved-key", "openai", "sk-never-shown")
    const revoked: string[] = []
    const lent: Grant = { ...grant("g-lent", { resource: { kind: "tree", ref: "~/notes" }, source: { kind: "device", device: "cloud-mac-id" }, mode: "live" }), scope: { level: "account", account: ACCOUNT } }
    const views = new SetupViews({
      now: () => NOW,
      recipe: async () => ({ project: "shop", root, recipe: { kind: "none" } }),
      accounts: async () => ({ providers: [], accounts: [] }),
      keys: async () => ({ connections: [], issues: [], secureStorage: true, harnesses: [] }),
      device: async () => ({ id: "cloud-mac-id", name: "MacBook Pro" }),
      label: (harness) => harness,
      borrowing: {
        local: async () => [checkouts, saved.broker],
        account: { snapshot: async () => ({ grants: [lent], leases: [], events: [], asks: [] }), answer: async () => undefined, revoke: async (id) => void revoked.push(id) },
        asker: (thread) => (thread === "t-2" ? { thread, title: "Pricing notes", fin: false } : undefined),
      },
    })
    const page = await views.view(root)
    const here = page.places[0]!
    assert.equal(here.id, `device:${LOCAL_DEVICE}`)
    const names = rows(here).map((row) => row.name)
    assert.ok(names.includes(".env.local"), names.join(", "))
    assert.equal(named(here, ".env.local").origin.from, "lease")
    assert.ok(names.includes("Saved key: openai"))
    assert.equal(named(here, "Saved key: openai").part, "access")
    assert.equal(rowAction(named(here, "~/notes"), NOW), "stop", "the account's grant sourced from this Mac is lent from here")
    assert.ok(!JSON.stringify(page).includes("never-read") && !JSON.stringify(page).includes("sk-never-shown"))

    assert.deepEqual(here.asks.map((ask) => [ask.by.title, askLine(ask).thing]), [["Pricing notes", "notes.md"]])
    assert.deepEqual(await views.act(root, { act: "answer", ask: here.asks[0]!.id, answer: "allow-thread" }), { done: true })
    assert.equal((await checkouts.asks()).length, 0)
    assert.equal((await checkouts.leases()).filter((held) => held.resource.ref === "notes.md").length, 1)

    const stopLent = rows(here).find((row) => row.name === "~/notes")!
    assert.deepEqual(await views.act(root, { act: "row", place: here.id, row: stopLent.id, action: "stop" }), { done: true })
    assert.deepEqual(revoked, ["g-lent"])
    const stopLocal = rows((await views.view(root)).places[0]!).find((row) => row.name.startsWith("Files Git ignores") && row.name.includes("copied"))!
    assert.deepEqual(await views.act(root, { act: "row", place: here.id, row: stopLocal.id, action: "stop" }), { done: true })
    assert.ok(!(await checkouts.grants()).some((held) => held.id === "device-checkouts-copy"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
