/**
 * Setup's rows and words (`@mako/protocol/setup`): every state said in words with one tone and its one button,
 * the six parts in their order, each grant and lease placed in its part and stated against its source (synced, newer,
 * a stale copy, a copy that didn't land, offline), what a device lends with Stop, asks in Needs you and in their part,
 * the grant an answer makes, a source's ask, a pattern grant's entries, a Thread's own place, the phone's one-line
 * parts, and the page's schema. No row carries a value or a content hash. A host's own readings and its brokers are
 * checked beside the host (`scripts/test-setup.ts`, `scripts/test-setup-host.ts`).
 */
import assert from "node:assert/strict"
import { test } from "node:test"
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
  SetupViewSchema,
  setupView,
  syncWords,
  threadPlace,
} from "../dist/setup.js"

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
const mac = {
  kind: "device",
  device: MAC,
  name: "MacBook Pro",
  platform: "mac",
  here: true,
  online: true,
}
const studio = {
  kind: "device",
  device: STUDIO,
  name: "Studio",
  platform: "linux",
  here: false,
  online: false,
  lastSeen: NOW - 3 * HOUR,
}
const cloud = { kind: "cloud" }
function grant(id, partial) {
  return {
    id,
    scope: { level: "project", account: ACCOUNT, repository: REPO },
    access:
      partial.resource.kind === "command" || partial.resource.kind === "port"
        ? "run"
        : "read",
    lifetime: { until: "revoked" },
    ask: "never",
    secret: false,
    grantedBy: { kind: "person", account: ACCOUNT },
    grantedAt: NOW - 9 * DAY,
    version: 1,
    ...partial,
  }
}
function lease(id, of, thread, where, at, extra = {}) {
  return {
    id,
    grant: of.id,
    grantVersion: of.version,
    borrower: {
      account: ACCOUNT,
      repository: REPO,
      thread,
      place:
        where === "cloud"
          ? { kind: "machine", machine: `m-${thread}` }
          : { kind: "device", device: where === "mac" ? MAC : STUDIO },
    },
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
const env = grant("g-env", {
  resource: { kind: "file", ref: ".env.local" },
  source: { kind: "device", device: MAC },
  mode: "copy",
  secret: true,
})
const config = grant("g-config", {
  resource: { kind: "file", ref: "config/dev.json" },
  source: { kind: "device", device: MAC },
  mode: "copy",
})
const outreach = grant("g-outreach", {
  resource: { kind: "tree", ref: "ignore/outreach" },
  source: { kind: "device", device: MAC },
  mode: "copy",
})
const notes = grant("g-notes", {
  resource: { kind: "tree", ref: "~/notes" },
  source: { kind: "device", device: MAC },
  mode: "live",
  ask: "first-use",
})
const pricing = grant("g-pricing", {
  resource: { kind: "credential", ref: "github:acme/pricing" },
  source: { kind: "mint", service: "github" },
  mode: "minted",
})
const deploy = grant("g-deploy", {
  resource: { kind: "credential", ref: "deploy" },
  source: { kind: "vault" },
  mode: "copy",
  secret: true,
  label: "Deploy token",
  lifetime: { until: "expires", at: Date.UTC(2027, 0, 31) },
})
const db = grant("g-db", {
  resource: { kind: "port", ref: "db.internal:5432" },
  source: { kind: "device", device: STUDIO },
  mode: "relay",
  ask: "first-use",
  label: "Staging database",
})
const infra = grant("g-infra", {
  resource: { kind: "command", ref: "infra plan **" },
  source: { kind: "device", device: MAC },
  mode: "relay",
  ask: "each-use",
})
const local = grant("g-local", {
  resource: { kind: "tree", ref: "fixtures/recordings" },
  source: { kind: "device", device: MAC },
  mode: "live",
  within: "source-device",
})
const elsewhere = grant("g-other", {
  resource: { kind: "file", ref: ".env" },
  source: { kind: "vault" },
  mode: "copy",
  scope: { level: "project", account: ACCOUNT, repository: "acme/other" },
})
const otherThread = grant("g-other-thread", {
  resource: { kind: "file", ref: "notes.md" },
  source: { kind: "vault" },
  mode: "copy",
  scope: { level: "thread", account: ACCOUNT, thread: "t-unknown" },
  lifetime: { until: "thread-ends" },
})
const mine = grant("g-mine", {
  resource: { kind: "file", ref: "scratch.md" },
  source: { kind: "vault" },
  mode: "copy",
  scope: { level: "thread", account: ACCOUNT, thread: "t-pool" },
  lifetime: { until: "thread-ends" },
})
const ask = {
  id: "ask-ledger",
  kind: "borrow",
  answer: "grant",
  by: { thread: "t-build", title: "Shop build", harness: "claude", fin: false },
  at: NOW - 4 * MIN,
  why: "borrow the payout batching",
  place: "cloud",
  offer: {
    resource: { kind: "credential", ref: "github:acme/ledger" },
    borrower: {
      account: ACCOUNT,
      repository: REPO,
      thread: "t-build",
      place: { kind: "machine", machine: "m-t-build" },
    },
    why: "borrow the payout batching",
    scope: { level: "thread", account: ACCOUNT, thread: "t-build" },
    mode: "minted",
  },
}
const toolAsk = {
  id: "ask-tf",
  kind: "tool",
  tool: "terraform",
  version: "1.9",
  by: { thread: "t-pool", title: "Payout pool", harness: "codex", fin: true },
  at: NOW - 3 * MIN,
  why: "provision the database",
  place: "cloud",
}
function broker(extra = {}) {
  return {
    account: ACCOUNT,
    grants: [
      env,
      config,
      outreach,
      notes,
      pricing,
      deploy,
      db,
      infra,
      local,
      elsewhere,
      otherThread,
      mine,
    ],
    leases: [
      lease("l-env", env, "t-build", "cloud", NOW - 2 * DAY, {
        version: HASH_B,
        delivery: { transfer: "inline", secret: true, size: 412 },
      }),
      lease("l-config", config, "t-build", "cloud", NOW - 2 * DAY, {
        delivery: { transfer: "inline", secret: false, size: 2_048 },
      }),
      lease("l-notes", notes, "t-build", "cloud", NOW - 3 * HOUR, {
        stale: { heldSince: NOW - 3 * HOUR, sourceLastSeen: NOW - 3 * HOUR },
      }),
      lease("l-pricing", pricing, "t-build", "cloud", NOW - 12 * MIN),
      lease("l-deploy-1", deploy, "t-build", "cloud", NOW - 40 * MIN),
      lease("l-deploy-2", deploy, "t-pool", "cloud", NOW - 70 * MIN),
      lease("l-env-studio", env, "t-studio", "studio", NOW - 3 * HOUR, {
        stale: { heldSince: NOW - 3 * HOUR, sourceLastSeen: NOW - 3 * HOUR },
      }),
    ],
    refusals: [
      {
        event: "refused",
        at: NOW - 3 * HOUR,
        grant: outreach.id,
        borrower: {
          account: ACCOUNT,
          repository: REPO,
          thread: "t-studio",
          place: { kind: "device", device: STUDIO },
        },
        resource: outreach.resource,
        refused: "unavailable",
        reason: "unreadable",
        correlationId: "c1",
      },
    ],
    asks: [ask, toolAsk],
    sourceVersions: { [env.id]: HASH_A },
    devices: {
      [MAC]: {
        name: "MacBook Pro",
        platform: "mac",
        online: true,
        lastSeen: NOW,
      },
      [STUDIO]: {
        name: "Studio",
        platform: "linux",
        online: false,
        lastSeen: NOW - 3 * HOUR,
      },
    },
    ...extra,
  }
}
const readings = () => [
  {
    place: mac,
    checkout: "~/src/shop",
    rows: [
      {
        reading: "repository",
        part: "code",
        icon: "repository",
        name: REPO,
        mono: true,
        detail: "The main checkout here",
        sync: { state: "synced", at: NOW },
      },
      {
        reading: "recipe-carry",
        part: "files",
        icon: "file",
        name: ".env.local",
        mono: true,
        detail: "Copied into each new worktree",
        sync: { state: "synced", at: NOW - HOUR },
      },
    ],
  },
  {
    place: cloud,
    base: {
      builtAt: NOW - 2 * HOUR,
      branch: "main",
      commit: "3f2a1c9e",
      tookMs: 72_000,
      bytes: 1.6 * 1024 ** 3,
    },
    rows: [
      {
        reading: "image",
        part: "tools",
        icon: "tool",
        name: "From Mako's image",
        mono: false,
        detail: "Node 24",
        sync: { state: "synced", at: NOW - 2 * HOUR },
      },
    ],
  },
  { place: studio, rows: [] },
]
const view = () =>
  setupView({
    now: NOW,
    project: { name: "shop", root: "/work/shop", repository: REPO },
    places: readings(),
    broker: broker(),
    threads: ["t-build", "t-pool", "t-studio"],
  })
const placeOf = (id) => view().places.find((place) => place.id === id)
const rows = (place) => place.parts.flatMap((part) => part.rows)
const named = (place, name) => {
  const found = rows(place).find((row) => row.name === name)
  assert.ok(
    found,
    `${place.id} has ${name}: ${rows(place)
      .map((row) => row.name)
      .join(", ")}`
  )
  return found
}
const said = (row) => syncWords(row.sync, NOW).words
test("every state is said in words, with one tone and at most one button", () => {
  const cases = [
    [
      { state: "synced", at: NOW - 2 * DAY },
      "Synced 2 d ago",
      "positive",
      undefined,
    ],
    [
      { state: "synced", at: NOW - 20_000 },
      "Synced just now",
      "positive",
      undefined,
    ],
    [{ state: "newer", source: "Mac's" }, "Mac's is newer", "caution", "send"],
    [
      { state: "stale", since: NOW - 3 * HOUR },
      "Copy · 3 h old",
      "caution",
      undefined,
    ],
    [{ state: "asked" }, "Waiting on you", "attention", undefined],
    [{ state: "missing" }, "Not here", "negative", "add"],
    [
      { state: "failed", why: "couldn't be read" },
      "Didn't copy: couldn't be read",
      "negative",
      "retry",
    ],
    [{ state: "here" }, "Stays here", "neutral", undefined],
    [{ state: "thread" }, "This Thread only", "neutral", "keep"],
    [{ state: "up", port: 20000 }, "Up on 20000", "positive", undefined],
    [
      { state: "offline", through: "MacBook Pro" },
      "MacBook Pro offline",
      "caution",
      undefined,
    ],
  ]
  for (const [sync, words, tone, action] of cases) {
    const result = syncWords(sync, NOW)
    assert.equal(result.words, words)
    assert.equal(result.tone, tone)
    assert.equal(result.action, action)
  }
  // Two states of one tone never share words: the dot's colour is never all a row says.
  const byTone = new Map()
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
  assert.deepEqual(SETUP_PARTS, [
    "needs",
    "code",
    "files",
    "access",
    "tools",
    "services",
  ])
  const places = view().places
  assert.deepEqual(
    places.map((place) => place.id),
    [`device:${MAC}`, "cloud", `device:${STUDIO}`]
  )
  for (const place of places)
    assert.deepEqual(
      place.parts.map((part) => part.part),
      SETUP_LIST_PARTS
    )
  assert.match(
    places[1].line,
    /^Each Thread gets a machine of its own, started from this project's base: built 2 h ago from main 3f2a1c in 1 min 12 s, 1.6 GB\.$/
  )
  assert.match(places[0].line, /worktrees of ~\/src\/shop/)
  assert.match(places[2].line, /Last online 3 h ago/)
})
test("each grant lands in its kind's part, said against its source at the place", () => {
  const atCloud = placeOf("cloud")
  const part = (name) => named(atCloud, name).part
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
  assert.match(
    deployRow.detail,
    /Kept encrypted in your account · agents see names only · lapses Jan 31/
  )
  assert.match(
    named(atCloud, "acme/pricing").detail,
    /From Mako's GitHub app, an hour at a time, nothing stored · read-only/
  )
  assert.match(
    named(atCloud, "config/dev.json").detail,
    /A copy from MacBook Pro · read-only · 2 KB/
  )
  assert.match(
    named(atCloud, "infra plan **").detail,
    /Runs on MacBook Pro, output sent back · asks each time/
  )
})
test("what a grant doesn't reach stays off the page", () => {
  const atCloud = placeOf("cloud")
  const names = rows(atCloud).map((row) => row.name)
  assert.ok(
    !names.includes("fixtures/recordings"),
    "a grant kept to its source device isn't the cloud's"
  )
  assert.ok(!names.includes(".env"), "another project's grant")
  assert.ok(
    !names.includes("notes.md"),
    "a grant of a Thread outside the project"
  )
  assert.ok(
    names.includes("scratch.md"),
    "a grant of one of the project's Threads"
  )
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
  assert.match(
    lentNotes.detail,
    /^Lent to Threads elsewhere while this device is online|^Read by 1 Thread elsewhere/
  )
  const lentEnv = rows(atMac).filter(
    (row) => row.name === ".env.local" && row.origin.from !== "reading"
  )
  assert.equal(lentEnv.length, 1)
  assert.equal(rowAction(lentEnv[0], NOW), "send")
  // A grant kept to its source device is the device's own, held, never lent, and the person can stop it here.
  const kept = named(atMac, "fixtures/recordings")
  assert.equal(kept.action, "stop")
  assert.ok(!/Read by|Lent/.test(kept.detail))
  // A Studio-sourced relay isn't the Mac's to lend, and nothing reached the Mac under it.
  assert.ok(!rows(atMac).some((row) => row.name === "Staging database"))
})
test("this device's own brokers: a pattern grant lists each entry taken, for this project's worktrees alone", () => {
  const LOCAL = "this-device"
  const here = {
    kind: "device",
    device: LOCAL,
    name: "MacBook Pro",
    platform: "mac",
    here: true,
    online: true,
  }
  const copies = grant("device-checkouts-copy", {
    resource: { kind: "tree", ref: "**" },
    source: { kind: "device", device: LOCAL },
    mode: "copy",
    scope: { level: "account", account: ACCOUNT },
    within: "source-device",
    label: "Files Git ignores, copied into worktrees",
  })
  const local = (id, ref, thread, repository) => ({
    ...lease(id, copies, thread, "mac", NOW - HOUR),
    resource: { kind: "file", ref },
    borrower: {
      account: ACCOUNT,
      repository,
      thread,
      place: { kind: "device", device: LOCAL },
    },
  })
  const page = setupView({
    now: NOW,
    project: { name: "shop", root: "/work/shop", repository: REPO },
    places: [
      {
        place: here,
        rows: [
          {
            reading: "recipe-carry",
            part: "files",
            icon: "file",
            name: ".env.local",
            mono: true,
            detail: "Copied into each new worktree",
            sync: { state: "synced", at: NOW - DAY },
          },
        ],
      },
    ],
    broker: {
      ...broker({
        grants: [copies],
        leases: [
          local("a", ".env.local", "t1", "/work/shop"),
          local("b", ".env.local", "t2", "/work/shop"),
          local("c", "secret.json", "t3", "/work/other"),
        ],
        asks: [],
        refusals: [],
      }),
      devices: {
        [LOCAL]: {
          name: "MacBook Pro",
          platform: "mac",
          online: true,
          lastSeen: NOW,
        },
      },
    },
  }).places[0]
  const names = rows(page).map((row) => row.name)
  assert.deepEqual(names, [
    "Files Git ignores, copied into worktrees",
    ".env.local",
  ])
  const entry = named(page, ".env.local")
  assert.equal(entry.origin.from, "lease")
  assert.equal(entry.detail, "Copied into 2 Threads' worktrees")
  assert.equal(said(entry), "Synced 1 h ago")
  assert.equal(
    rowAction(named(page, "Files Git ignores, copied into worktrees"), NOW),
    "stop"
  )
})
test("a source's ask of this device's person waits in Needs you, answered for its Thread or declined", () => {
  const waiting = {
    at: NOW - 2 * MIN,
    ask: {
      ask: "src-1",
      grant: notes.id,
      resource: notes.resource,
      ref: "~/notes/plan.md",
      mode: "live",
      borrower: {
        account: ACCOUNT,
        repository: REPO,
        thread: "t-build",
        place: { kind: "machine", machine: "m-1" },
      },
      why: "read the pricing notes",
      askPerson: true,
    },
  }
  const asked = sourceAskOf(waiting, "cloud", {
    thread: "t-build",
    title: "Shop build",
    fin: false,
  })
  assert.equal(asked.kind === "borrow" && asked.answer, "source")
  assert.deepEqual(askAnswers(asked), ["allow-thread", "decline"])
  assert.equal(askLine(asked).thing, "~/notes/plan.md")
  const page = setupView({
    now: NOW,
    project: { name: "shop", root: "/work/shop", repository: REPO },
    places: readings(),
    broker: broker({ asks: [asked] }),
    threads: ["t-build"],
  })
  const atCloud = page.places.find((place) => place.id === "cloud")
  assert.deepEqual(
    atCloud.asks.map((entry) => entry.id),
    ["src-1"]
  )
  assert.equal(
    said(rows(atCloud).find((row) => row.origin.from === "ask")),
    "Waiting on you"
  )
})
test("a grant's row takes the place of a reading of the same thing", () => {
  const cloudRows = setupView({
    now: NOW,
    project: { name: "shop", root: "/work/shop", repository: REPO },
    places: [
      {
        place: cloud,
        rows: [
          {
            reading: "carried-cloud",
            part: "files",
            icon: "file",
            name: "config/dev.json",
            mono: true,
            detail: "From MacBook Pro",
            sync: { state: "missing" },
          },
        ],
      },
    ],
    broker: broker(),
  }).places[0]
  const matches = rows(cloudRows).filter(
    (row) => row.name === "config/dev.json"
  )
  assert.equal(matches.length, 1)
  assert.equal(matches[0].origin.from, "lease")
})
test("asks wait in Needs you and in their own part, answered with the narrowest reach first", () => {
  const atCloud = placeOf("cloud")
  assert.deepEqual(
    atCloud.asks.map((entry) => entry.id),
    ["ask-ledger", "ask-tf"]
  )
  assert.equal(placeOf(`device:${MAC}`).asks.length, 0)
  const asked = named(atCloud, "acme/ledger")
  assert.equal(asked.part, "code")
  assert.equal(said(asked), "Waiting on you")
  assert.match(asked.detail, /^Asked for by Shop build, 4 min ago$/)
  assert.equal(named(atCloud, "terraform").part, "tools")
  assert.deepEqual(askAnswers(ask), [
    "allow-thread",
    "allow-project",
    "decline",
  ])
  assert.deepEqual(askAnswers(toolAsk), ["add-to-setup", "decline"])
  assert.equal(askAnswerLabel(ask, "allow-thread"), "Allow for this Thread")
  assert.equal(askAnswerLabel(ask, "allow-project", true), "For the project")
  assert.equal(
    askAnswerLabel(toolAsk, "add-to-setup"),
    "Add terraform 1.9 to setup"
  )
  assert.equal(askAnswerLabel(toolAsk, "add-to-setup", true), "Add to setup")
})
test("an answer makes the grant the person chose, and Decline makes none", () => {
  const made = {
    id: "g-new",
    account: ACCOUNT,
    source: { kind: "vault" },
    at: NOW,
  }
  const thread = grantForAnswer(ask, "allow-thread", made)
  assert.deepEqual(thread.scope, {
    level: "thread",
    account: ACCOUNT,
    thread: "t-build",
  })
  assert.deepEqual(thread.lifetime, { until: "thread-ends" })
  assert.deepEqual(
    thread.source,
    { kind: "mint", service: "github" },
    "a repository is always minted"
  )
  assert.equal(thread.grantedBy.kind, "person")
  const project = grantForAnswer(ask, "allow-project", made)
  assert.deepEqual(project.scope, {
    level: "project",
    account: ACCOUNT,
    repository: REPO,
  })
  assert.deepEqual(project.lifetime, { until: "revoked" })
  assert.equal(grantForAnswer(ask, "decline", made), undefined)
  assert.equal(grantForAnswer(toolAsk, "add-to-setup", made), undefined)
  const file = {
    ...ask,
    offer: {
      ...ask.offer,
      resource: { kind: "file", ref: "~/notes/a.md" },
      mode: "copy",
    },
  }
  const fromMac = grantForAnswer(file, "allow-project", {
    ...made,
    source: { kind: "device", device: MAC },
  })
  assert.equal(
    fromMac.ask,
    "first-use",
    "a device's grant asks it the first time"
  )
  assert.equal(fromMac.access, "read")
})
test("a Thread's own place keeps its own asks and leaves out other Threads' grants", () => {
  const whole = view()
  const own = threadPlace(whole, "cloud", "t-pool")
  assert.deepEqual(
    own.asks.map((entry) => entry.id),
    ["ask-tf"]
  )
  assert.ok(rows(own).some((row) => row.name === "terraform"))
  assert.ok(!rows(own).some((row) => row.name === "acme/ledger"))
  assert.ok(rows(own).some((row) => row.name === "scratch.md"))
  const build = threadPlace(whole, "cloud", "t-build")
  assert.ok(!rows(build).some((row) => row.name === "scratch.md"))
})
test("a part folds to one line led by what needs a look", () => {
  const atCloud = placeOf("cloud")
  const code = atCloud.parts.find((part) => part.part === "code")
  assert.deepEqual(partSummary(code, NOW), {
    line: "acme/ledger: waiting on you · acme/pricing",
    tone: "attention",
  })
  const files = atCloud.parts.find((part) => part.part === "files")
  assert.equal(partSummary(files, NOW).tone, "caution")
  assert.match(partSummary(files, NOW).line, /^\.env\.local: mac's is newer · /)
  assert.deepEqual(partSummary({ part: "services", rows: [] }, NOW), {
    line: "Nothing yet",
    tone: "neutral",
  })
})
test("no row carries a value or a content hash", () => {
  const page = JSON.stringify(view())
  assert.ok(!page.includes(HASH_A) && !page.includes(HASH_B))
})
test("a page parses by its own schema, as the account's broker and a browser read it", () => {
  const page = view()
  assert.deepEqual(
    SetupViewSchema.parse(JSON.parse(JSON.stringify(page))),
    page
  )
  assert.throws(() =>
    SetupViewSchema.parse({
      ...page,
      places: [{ ...page.places[0], parts: [{ part: "needs", rows: [] }] }],
    })
  )
})

test("an answer grants exactly what was asked: its kind and ref, never a pattern or the project's whole carry", () => {
  const made = { id: "g-exact", account: ACCOUNT, source: { kind: "device", device: MAC }, at: NOW }
  for (const ref of ["selected.env", "~/notes/plan.md", "github:acme/ledger"]) {
    const kind = ref.startsWith("github:") ? "credential" : "file"
    const asked = { ...ask, offer: { ...ask.offer, resource: { kind, ref }, mode: kind === "file" ? "copy" : "minted" } }
    for (const answer of ["allow-thread", "allow-project"]) {
      const given = grantForAnswer(asked, answer, made)
      assert.deepEqual(given.resource, { kind, ref }, `${answer} on ${ref}`)
      assert.ok(!/[*?]/.test(given.resource.ref))
    }
  }
})

test("a browser builds a project's page from the account broker alone, by the same rows", async () => {
  const { accountSetupView } = await import("../dist/setup.js")
  const lentFromMac = grant("g-lent", { resource: { kind: "tree", ref: "~/notes" }, source: { kind: "device", device: MAC }, mode: "live" })
  const other = grant("g-other-project", { resource: { kind: "file", ref: ".env" }, source: { kind: "vault" }, mode: "copy", scope: { level: "project", account: ACCOUNT, repository: "acme/other" } })
  const page = accountSetupView({
    now: NOW,
    project: "shop",
    devices: [{ id: MAC, name: "MacBook Pro", platform: "macOS 26.1", lastSeenAt: new Date(NOW - HOUR).toISOString() }],
    snapshot: { grants: [pricing, lentFromMac, other], leases: [lease("l-pricing", pricing, "t-build", "cloud", NOW - 12 * MIN)], events: [], asks: [] },
  })
  assert.equal(page.repository, REPO, "the repository the broker names that ends with the project's folder")
  assert.deepEqual(page.places.map((place) => place.id), ["cloud", `device:${MAC}`])
  const atCloud = page.places[0]
  assert.deepEqual(rows(atCloud).map((row) => row.name), [REPO, "acme/pricing", "~/notes"])
  assert.ok(!rows(atCloud).some((row) => row.name === ".env"), "another project's grant")
  assert.equal(syncWords(named(atCloud, "acme/pricing").sync, NOW).words, "Synced 12 min ago")
  const atMac = page.places[1]
  assert.equal(rowAction(named(atMac, "~/notes"), NOW), "stop", "what the Mac lends, stoppable from the phone")
  assert.match(atMac.line, /Last online 1 h ago/)
})

test("a command or a port ask can only be declined, until a device can run or reach it for another place", () => {
  for (const kind of ["command", "port"]) {
    const asked = { ...ask, answer: "source", offer: { ...ask.offer, resource: { kind, ref: kind === "command" ? "infra plan" : "db.internal:5432" }, mode: "relay" } }
    assert.deepEqual(askAnswers(asked), ["decline"])
  }
})
