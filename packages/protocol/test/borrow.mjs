import "./borrow-composition.mjs"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, test } from "node:test"
import {
  BorrowerSchema,
  NeedSchema,
  BorrowAnswerSchema,
  SourceAnswerSchema,
  BorrowPushSchema,
  GrantSchema,
  KIND_ACCESS,
  KIND_MODES,
  KINDS,
  LeaseEventSchema,
  borrowSealContext,
  chooseGrant,
  emptyBroker,
  needKey,
  grantExpiry,
  inScope,
  liveLeases,
  reachesBorrower,
  selects,
  standingGrants,
  step,
  route,
  freeSlots,
  satisfies,
  SESSION_LOST_BEATS,
  WAIT_MAX_MS,
} from "../dist/borrow.js"

const ACCOUNT = "acct-a"
const HOUR = 60 * 60_000

function lcg(seed) {
  let value = seed >>> 0
  const next = () => (value = (Math.imul(value, 1664525) + 1013904223) >>> 0) / 2 ** 32
  return { next, int: (n) => Math.floor(next() * n), pick: (list) => list[Math.floor(next() * list.length)] }
}

const THREADS = Array.from({ length: 40 }, (_, index) => ({ thread: `t${index + 1}`, repository: index % 2 ? "acme/api" : "acme/web" }))
const PLACES = [{ kind: "device", device: "mac" }, { kind: "machine", machine: "m1" }, { kind: "device", device: "studio" }]
const REFS = {
  file: [".env", "config/dev.json", "~/flage/README.md", "../outside"],
  tree: ["fixtures", "fixtures/a.json", "~/flage/src", "~/flage/src/x/y.ts"],
  env: ["DATABASE_URL", "STRIPE_KEY"],
  credential: ["github-app", "cloudflare", "claude"],
  command: ["aws rds describe-db-instances", "aws s3 ls", "op read x"],
  port: ["db.internal:5432"],
}
const PATTERNS = {
  file: [".env", "config/*.json", "~/flage/**", "*"],
  tree: ["fixtures", "~/flage/src", "**"],
  env: ["DATABASE_URL", "*"],
  credential: ["github-app", "cloudflare", "*"],
  command: ["aws rds describe-db-instances", "aws **", "op read *"],
  port: ["db.internal:5432", "*"],
}

const sha = (text) => createHash("sha256").update(text).digest("hex")

function borrower(random, account = ACCOUNT) {
  const thread = random.pick(THREADS)
  return { account, repository: thread.repository, thread: thread.thread, place: random.pick(PLACES) }
}

function scope(random) {
  const thread = random.pick(THREADS)
  const account = random.next() < 0.1 ? "acct-b" : ACCOUNT
  return random.pick([
    { level: "thread", account, thread: thread.thread },
    { level: "project", account, repository: thread.repository },
    { level: "account", account },
  ])
}

const PLAIN_KINDS = KINDS.filter((kind) => kind !== "operation")

function grant(random, id, at) {
  const kind = random.pick(PLAIN_KINDS)
  const mode = random.pick(KIND_MODES[kind])
  const sources =
    mode === "relay" ? [{ kind: "device", device: "mac" }, { kind: "device", device: "studio" }]
    : mode === "minted" ? [{ kind: "mint", service: "github-app" }, { kind: "vault" }]
    : [{ kind: "device", device: "mac" }, { kind: "device", device: "studio" }, { kind: "vault" }]
  const source = random.pick(sources)
  const grantScope = scope(random)
  const lifetimes = [{ until: "revoked" }, { until: "expires", at: at + random.int(6) * HOUR }, { until: "once" }]
  if (grantScope.level === "thread") lifetimes.push({ until: "thread-ends" })
  const made = {
    id,
    resource: { kind, ref: random.pick(PATTERNS[kind]) },
    source,
    scope: grantScope,
    mode,
    access: random.pick(KIND_ACCESS[kind]),
    lifetime: random.pick(lifetimes),
    ask: source.kind === "device" ? random.pick(["never", "first-use", "each-use"]) : "never",
    secret: random.next() < 0.5,
    grantedBy: { kind: "person", account: grantScope.account },
    grantedAt: at,
    version: 1,
  }
  if (source.kind === "device" && random.next() < 0.3) made.within = "source-device"
  // The person's devices a borrower there may borrow under it; a device borrower needs one of these, or `within`.
  else if (random.next() < 0.4) made.devices = random.pick([["mac"], ["studio"], ["mac", "studio"]])
  return made
}

/** The values the sources hold, which no decision, log line, push or listing may ever contain. */
function canary(random) {
  return `VALUE-${random.int(2 ** 31).toString(16)}-${random.int(2 ** 31).toString(16)}`
}

function walk(seed, steps, tally) {
  const random = lcg(seed)
  let state = emptyBroker(ACCOUNT)
  let at = 1_800_000_000_000
  let grants = 0
  let correlations = 0
  const values = []
  const revokedGrants = new Set()
  const endedThreads = new Set()
  const leaseByNeed = new Map()
  const grantedPerNeed = new Map()
  const consentedLeases = new Set()
  const seenLeaseIds = new Set()

  for (let index = 0; index < steps; index++) {
    at += random.int(3) === 0 ? random.int(4) * HOUR : random.int(60_000)
    const before = state
    const roll = random.next()
    let input
    if (roll < 0.15) {
      const id = random.next() < 0.2 && grants ? `g${random.int(grants)}` : `g${grants++}`
      const known = before.grants[id]
      const next = grant(random, id, at)
      if (known) next.version = known.grant.version + (random.next() < 0.8 ? 1 : 0)
      input = { type: "grant", grant: next, at }
    } else if (roll < 0.22 && grants) input = { type: "revoke", grant: `g${random.int(grants)}`, by: { kind: "person", account: ACCOUNT }, at }
    else if (roll < 0.55) {
      const kind = random.pick(PLAIN_KINDS)
      const correlationId = random.next() < 0.3 && correlations ? `c${random.int(correlations)}` : `c${correlations++}`
      const value = canary(random)
      values.push(value)
      const holding = random.next() < 0.3 ? { version: sha(canary(random)), at: at - random.int(10) * HOUR } : undefined
      const need = { kind, ref: random.pick(REFS[kind]), for: borrower(random, random.next() < 0.05 ? "acct-b" : ACCOUNT), why: `needs it ${value.slice(0, 2)}`, correlationId }
      if (holding) need.holding = holding
      if (random.next() < 0.2) need.mode = random.pick(KIND_MODES[kind])
      input = { type: "borrow", need, at, lease: `l${index}`, ask: `a${index}`, content: random.next() < 0.9 ? { version: sha(value), size: random.int(200_000) } : undefined }
    } else if (roll < 0.68 && Object.keys(before.asks).length) {
      const ask = random.pick(Object.keys(before.asks))
      const value = canary(random)
      values.push(value)
      const answer = random.pick([
        { answer: "yes", version: sha(value), size: random.int(100_000) },
        { answer: "yes", version: sha(value) },
        { answer: "no", by: { kind: "person", account: ACCOUNT, device: "mac" } },
        { answer: "unavailable", reason: random.pick(["not-found", "outside", "unreadable", "changed", "error"]) },
      ])
      input = { type: "source-answer", ask, answer, at }
    } else if (roll < 0.76 && Object.keys(before.leases).length) input = { type: random.next() < 0.6 ? "renew" : "release", lease: random.pick(Object.keys(before.leases)), at }
    else if (roll < 0.86) input = { type: "device", device: random.pick(["mac", "studio"]), online: random.next() < 0.6, at }
    else if (roll < 0.9) input = { type: "thread-ended", account: ACCOUNT, thread: random.pick(THREADS).thread, at }
    else if (roll < 0.94 && grants) {
      const value = canary(random)
      values.push(value)
      input = { type: "source-version", grant: `g${random.int(grants)}`, version: sha(value), at }
    } else input = { type: "tick", at }

    const result = step(before, input)
    state = result.state
    tally[input.type] = (tally[input.type] ?? 0) + 1
    if (result.rejected) tally.rejected = (tally.rejected ?? 0) + 1
    const events = result.effects.filter((effect) => effect.effect === "log").map((effect) => effect.event)
    const pushes = result.effects.filter((effect) => effect.effect === "push")
    for (const event of events) {
      LeaseEventSchema.parse(event)
      tally[`event:${event.event}`] = (tally[`event:${event.event}`] ?? 0) + 1
    }
    for (const push of pushes) BorrowPushSchema.parse(push.push)
    if (result.answer) BorrowAnswerSchema.parse(result.answer)
    for (const effect of result.effects) if (effect.effect === "ask") assert.equal(effect.device, before.grants[effect.ask.grant]?.grant.source.device ?? state.grants[effect.ask.grant].grant.source.device)

    const where = `seed ${seed}, step ${index}, ${input.type}`

    // 1. Scope: every lease granted reaches only a borrower inside its grant, for a resource it selects.
    for (const event of events.filter((line) => line.event === "granted")) {
      const lease = state.leases[event.lease].lease
      const held = state.grants[lease.grant].grant
      assert.ok(inScope(held.scope, lease.borrower), `${where}: a lease outside its grant's scope`)
      assert.ok(reachesBorrower(held, lease.borrower), `${where}: a lease to another place than its grant keeps to`)
      assert.ok(selects(held.resource, lease.resource.kind, lease.resource.ref), `${where}: a lease its grant doesn't select`)
      assert.equal(lease.borrower.account, ACCOUNT, `${where}: a lease to another account`)
      assert.ok(!seenLeaseIds.has(lease.id), `${where}: a lease ID issued twice`)
      seenLeaseIds.add(lease.id)
    }

    // 2. Monotone revocation.
    if (input.type === "revoke" && !result.rejected) {
      revokedGrants.add(input.grant)
      for (const held of Object.values(before.leases))
        if (held.lease.grant === input.grant && !held.ended) {
          assert.ok(events.some((line) => line.event === "revoked" && line.lease === held.lease.id) || events.some((line) => line.event === "expired" && line.lease === held.lease.id), `${where}: a live lease kept no end`)
          assert.ok(pushes.some((push) => push.push.push === "ended" && push.push.lease === held.lease.id), `${where}: its borrower wasn't told`)
        }
    }
    for (const event of events) if ((event.event === "granted" || event.event === "renewed") && revokedGrants.has(event.grant)) assert.fail(`${where}: a lease under a revoked grant`)
    if (input.type === "grant" && revokedGrants.has(input.grant.id)) assert.ok(result.rejected, `${where}: a revoked grant came back`)
    for (const id of revokedGrants) assert.equal(liveLeases(state, { grant: id }).length, 0, `${where}: a live lease under revoked ${id}`)

    // A Thread that ended is lent nothing more, whatever answers or grants come after.
    if (input.type === "thread-ended") endedThreads.add(`${input.account}\0${input.thread}`)
    for (const event of events.filter((line) => line.event === "granted"))
      assert.ok(!endedThreads.has(`${event.borrower.account}\0${event.borrower.thread}`), `${where}: a lease to a Thread that ended`)
    for (const lease of liveLeases(state)) assert.ok(!endedThreads.has(`${lease.borrower.account}\0${lease.borrower.thread}`) || lease.issuedAt < 0, `${where}: a live lease of an ended Thread`)

    // 3. Expiry: no lease outlives its grant, and none lives past its own end.
    for (const lease of liveLeases(state)) {
      const expiry = grantExpiry(state.grants[lease.grant].grant)
      if (expiry !== undefined) assert.ok(lease.expiresAt <= expiry, `${where}: a lease outlives its grant`)
      assert.ok(lease.expiresAt > at, `${where}: a live lease past its end`)
    }

    // 4. No value in the log, a push, an ask or a listing.
    const said = JSON.stringify([events, result.effects, result.answer ?? null, liveLeases(state), standingGrants(state, at)])
    for (const value of values) assert.ok(!said.includes(value), `${where}: a value in what the broker says`)

    // 5. Source consent.
    if (input.type === "source-answer" && result.answer && "lease" in result.answer) {
      assert.equal(input.answer.answer, "yes", `${where}: a lease without the device's yes`)
      consentedLeases.add(result.answer.lease.id)
    }
    for (const event of events.filter((line) => line.event === "granted")) {
      const lease = state.leases[event.lease].lease
      const held = state.grants[lease.grant] ?? before.grants[lease.grant]
      if (lease.source.kind !== "device") continue
      if (lease.stale) assert.ok(held.grant.ask === "never" || held.consented.includes(`${lease.borrower.account}\0${lease.borrower.repository}\0${lease.borrower.thread}`), `${where}: a stale copy without consent`)
      else assert.ok(consentedLeases.has(lease.id), `${where}: a device lease issued without its device`)
    }
    if (input.type === "source-answer" && input.answer.answer === "no" && result.answer && !before.grants[before.asks[input.ask].grant]?.ended)
      assert.equal(result.answer.refusal?.refused, "declined", `${where}: the device's no wasn't kept`)

    // 6. Idempotence.
    if (input.type === "borrow" && !result.rejected) {
      const key = needKey(input.need.for, input.need.correlationId)
      const first = leaseByNeed.get(key)
      const firstHeld = first && state.leases[first.lease.id]
      const firstLive = firstHeld && !firstHeld.ended
      if (firstLive) assert.deepEqual(result.answer, first, `${where}: the same need answered twice differently`)
      else if (firstHeld) assert.ok(["expired", "revoked", "thread-ended"].includes(result.answer.refusal?.refused), `${where}: an ended lease answered again`)
      else if (result.answer && "lease" in result.answer) leaseByNeed.set(key, result.answer)
    }
    for (const event of events.filter((line) => line.event === "granted")) {
      const key = needKey(event.borrower, event.correlationId)
      const earlier = grantedPerNeed.get(key)
      assert.ok(earlier === undefined || !before.leases[earlier], `${where}: one need given two leases`)
      grantedPerNeed.set(key, event.lease)
    }
    if (input.type === "source-answer" && result.answer && "lease" in result.answer) {
      const asked = before.asks[input.ask].need
      leaseByNeed.set(needKey(asked.for, asked.correlationId), result.answer)
    }

    // 7. Offline is typed.
    if (input.type === "borrow" && !result.rejected && !before.answers[needKey(input.need.for, input.need.correlationId)]) {
      const chosen = chooseGrant(before, input.need, at)
      if ("grant" in chosen && chosen.grant.grant.source.kind === "device" && !before.devices[chosen.grant.grant.source.device]?.online) {
        const answer = result.answer
        assert.ok(("lease" in answer && answer.lease.stale) || ["source-offline", "expired", "thread-ended"].includes(answer.refusal?.refused), `${where}: an offline source answered ${JSON.stringify(answer)}`)
        tally.offline = (tally.offline ?? 0) + 1
      }
    }
    if (input.type === "device" && !input.online)
      for (const push of pushes) if (push.push.push === "decided" && "refusal" in push.push.answer) assert.ok(["source-offline", "expired", "revoked"].includes(push.push.answer.refusal.refused), `${where}: a wait ended untyped`)
  }
}

describe("borrowing: the broker's seven rules over generated sequences", () => {
  test("40 seeded walks of 400 steps keep every rule after every step", () => {
    const tally = {}
    for (let seed = 1; seed <= 40; seed++) walk(seed, 400, tally)
    for (const kind of ["granted", "renewed", "refused", "revoked", "expired", "released", "asked"]) assert.ok((tally[`event:${kind}`] ?? 0) > 5, `the walks reached too few ${kind} events: ${JSON.stringify(tally)}`)
    assert.ok((tally.offline ?? 0) > 10, `the walks reached too few offline sources: ${tally.offline}`)
    assert.ok((tally.rejected ?? 0) > 5, "the walks sent too few inputs the broker refuses")
  })
})

// ---- Capable devices: routing, waiting, sessions (rules 8 to 12) ----

const DEVICES = ["mac", "studio", "mini", "linux"]
const OFFERS = [
  { capability: "ios-simulator", version: "26.1", attributes: { runtime: "iOS 26.1", device: "iPhone 17" } },
  { capability: "ios-simulator", version: "25.4", attributes: { runtime: "iOS 25.4", device: "iPad" } },
  { capability: "xcode", version: "17.1" },
  { capability: "xcode", version: "16.4" },
  { capability: "android-emulator", version: "36", attributes: { api: "36" } },
  { capability: "gpu", attributes: { kind: "metal" } },
]
const QUERIES = [
  { capability: "ios-simulator", where: { runtime: "iOS 26.*" } },
  { capability: "ios-simulator" },
  { capability: "xcode", version: "17.*" },
  { capability: "android-emulator" },
  { capability: "gpu", where: { kind: "metal" } },
]
const OPERATIONS = ["ios-simulator.session", "xcodebuild", "gradle"]

function capableGrant(random, id, at) {
  const grantScope = random.pick([{ level: "account", account: ACCOUNT }, { level: "project", account: ACCOUNT, repository: random.pick(["acme/web", "acme/api"]) }, scope(random)])
  const source = { kind: "capable", requires: [random.pick(QUERIES)] }
  if (random.next() < 0.3) source.devices = DEVICES.filter(() => random.next() < 0.6)
  if (source.devices && !source.devices.length) delete source.devices
  return {
    id,
    resource: { kind: "operation", ref: random.pick(["ios-simulator.*", "xcodebuild", "*"]) },
    source,
    scope: grantScope,
    mode: "relay",
    access: "run",
    lifetime: random.pick([{ until: "revoked" }, { until: "revoked" }, { until: "expires", at: at + random.int(8) * HOUR }]),
    ask: random.pick(["never", "first-use", "each-use"]),
    secret: false,
    grantedBy: { kind: "person", account: grantScope.account },
    grantedAt: at,
    version: 1,
    ...(random.next() < 0.6 && { devices: random.pick([["mac"], ["studio"], ["mac", "studio"]]) }),
  }
}

function walkCapable(seed, steps, tally) {
  const random = lcg(seed)
  let state = emptyBroker(ACCOUNT)
  let at = 1_800_000_000_000
  let grants = 0
  let correlations = 0
  const consentedAsks = new Map()
  for (let index = 0; index < steps; index++) {
    at += random.int(4) === 0 ? random.int(30) * 60_000 : random.int(40_000)
    const before = state
    const roll = random.next()
    let input
    if (roll < 0.05) input = { type: "grant", grant: capableGrant(random, `g${grants++}`, at), at }
    else if (roll < 0.08 && grants) {
      // The same grant, changed: its scope, places and resource move, often narrower than what waits under it.
      const id = `g${random.int(grants)}`
      const known = before.grants[id]
      const next = capableGrant(random, id, at)
      if (known) next.version = known.grant.version + 1
      input = { type: "grant", grant: next, at }
    }
    else if (roll < 0.1 && grants) input = { type: "revoke", grant: `g${random.int(grants)}`, by: { kind: "person", account: ACCOUNT }, at }
    else if (roll < 0.22) input = { type: "advertise", device: random.pick(DEVICES), capabilities: OFFERS.filter(() => random.next() < 0.5), slots: { used: random.int(3), of: 1 + random.int(4) }, at }
    else if (roll < 0.3) input = { type: "device", device: random.pick(DEVICES), online: random.next() < 0.4, at }
    else if (roll < 0.55) {
      const correlationId = random.next() < 0.2 && correlations ? `c${random.int(correlations)}` : `c${correlations++}`
      const need = { kind: "operation", ref: random.pick(OPERATIONS), for: borrower(random), why: "drive the app", correlationId }
      if (random.next() < 0.3) need.requires = [random.pick(QUERIES)]
      if (random.next() < 0.3) need.deadline = at + random.int(3) * HOUR
      input = { type: "borrow", need, at, lease: `l${index}`, ask: `a${index}` }
    } else if (roll < 0.7 && Object.keys(before.asks).length) {
      const ask = random.pick(Object.keys(before.asks))
      const answer = random.pick([{ answer: "yes", version: "v1" }, { answer: "yes", version: "v1" }, { answer: "no", by: { kind: "person", account: ACCOUNT } }, { answer: "unavailable", reason: "error" }])
      input = { type: "source-answer", ask, answer, at }
    } else if (roll < 0.85) {
      const live = Object.values(before.leases).filter((held) => !held.ended)
      if (!live.length) input = { type: "tick", at }
      else {
        const held = random.pick(live).lease
        const lease = held.id
        // Mostly the lease's own device; now and then another, which is never heard.
        const device = random.next() < 0.85 ? held.device : random.pick(DEVICES.filter((id) => id !== held.device))
        const canary = `CANARY_${seed}_${index}`
        input = random.pick([
          { type: "heartbeat", lease, device, at },
          { type: "heartbeat", lease, device, streams: [{ name: "screen", kind: "video" }, { name: "console", kind: "text" }], at },
          { type: "progress", lease, device, progress: { phase: random.pick(["booting", "running", "testing"]), percent: random.int(101) }, at },
          { type: "artifact", lease, device, artifact: { name: random.pick(["sign-in.mov", "results.xml", "shot.png"]), hash: sha(`${seed}:${index}`), size: random.int(1 << 20) }, at },
          // A device that tries to put a value where a name goes: as a path, or as the contents themselves.
          { type: "artifact", lease, device: held.device, artifact: { name: random.pick([`../${canary}`, `tmp/${canary}/out.mov`, `${canary}`.padEnd(400, "x")]), hash: sha(canary), size: 1 }, at },
          { type: "cancel", lease, by: { kind: "person", account: ACCOUNT }, at },
          { type: "release", lease, at },
        ])
      }
    } else if (roll < 0.9) input = { type: "thread-ended", account: ACCOUNT, thread: random.pick(THREADS).thread, at }
    else input = { type: "tick", at }

    const result = step(before, input)
    state = result.state
    const where = `capable seed ${seed}, step ${index}, ${input.type}`
    // Inputs a session's own device alone may give: from any other device, rejected, and nothing changes but time.
    if (["heartbeat", "progress", "artifact"].includes(input.type) && before.leases[input.lease] && input.device !== before.leases[input.lease].lease.device) {
      assert.ok(result.rejected, `${where}: a session heard another device`)
      assert.deepEqual(result.state, step(before, { type: "tick", at }).state, `${where}: another device's word changed something`)
      tally.wrongDevice = (tally.wrongDevice ?? 0) + 1
    }
    // Every lease on a device that ended in this step tells its device exactly once, and no other lease is told of.
    const tells = result.effects.filter((effect) => effect.effect === "tell")
    for (const tell of tells) BorrowPushSchema.parse(tell.push)
    for (const [id, held] of Object.entries(state.leases)) {
      const ended = held.ended && !before.leases[id]?.ended && held.lease.device
      const told = tells.filter((tell) => tell.push.lease === id)
      assert.equal(told.length, ended ? 1 : 0, `${where}: ${id} told its device ${told.length} times`)
      if (ended) assert.deepEqual(told[0], { effect: "tell", device: held.lease.device, push: { push: "ended", lease: id, why: held.ended.why } })
      // A session's files are listed only while it lives.
      if (held.ended) assert.equal(held.lease.session?.artifacts, undefined, `${where}: an ended lease still lists files`)
      // No name it lists carries a value.
      for (const named of [...(held.lease.session?.artifacts ?? []), ...(held.lease.session?.streams ?? [])]) assert.ok(!named.name.includes("CANARY"), `${where}: a name holds a value`)
    }
    tally.told = (tally.told ?? 0) + tells.length
    // A session's file is let go only when no live lease of its grant names it.
    for (const effect of result.effects.filter((effect) => effect.effect === "unreferenced"))
      assert.ok(!Object.values(state.leases).some((other) => !other.ended && other.lease.grant === effect.grant && other.lease.session?.artifacts?.some((each) => each.hash === effect.version)), `${where}: a file let go that a live session still names`)
    if (input.type === "artifact" && !result.rejected) tally.artifacts = (tally.artifacts ?? 0) + 1
    tally[input.type] = (tally[input.type] ?? 0) + 1
    const events = result.effects.filter((effect) => effect.effect === "log").map((effect) => effect.event)
    for (const event of events) {
      LeaseEventSchema.parse(event)
      tally[`event:${event.event}`] = (tally[`event:${event.event}`] ?? 0) + 1
    }
    for (const push of result.effects.filter((effect) => effect.effect === "push")) {
      BorrowPushSchema.parse(push.push)
      if (push.push.push === "decided" && push.push.answer.refusal?.refused === "no-capable-device") tally.timedOut = (tally.timedOut ?? 0) + 1
    }
    if (result.answer) BorrowAnswerSchema.parse(result.answer)
    if (result.answer?.pending === "capacity") tally.waited = (tally.waited ?? 0) + 1

    // 8. Routing: a device asked is allowed, able and online, and the ask fits its free slots.
    for (const effect of result.effects.filter((effect) => effect.effect === "ask")) {
      const held = state.grants[effect.ask.grant].grant
      const device = state.devices[effect.device]
      const asked = state.asks[effect.ask.ask]
      assert.ok(device?.online, `${where}: asked an offline device`)
      if (held.source.devices) assert.ok(held.source.devices.includes(effect.device), `${where}: asked a device the grant doesn't name`)
      assert.ok(satisfies(device.capabilities ?? [], [...held.source.requires, ...(asked.need.requires ?? [])]), `${where}: asked a device that can't serve it`)
      if (input.type !== "advertise") assert.ok(freeSlots(state, effect.device) >= 0, `${where}: asked a device with no slot free`)
      consentedAsks.set(effect.ask.ask, effect.device)
    }
    // 9. One slot, one lease: what the broker holds on a device never exceeds its free slots, but when the device itself shrank them.
    if (input.type !== "advertise") for (const id of DEVICES) if (before.devices[id]?.slots && freeSlots(before, id) >= 0) assert.ok(freeSlots(state, id) >= 0, `${where}: ${id} overcommitted`)
    // Scope and consent for capable leases: granted only on the device's yes, to the device it asked, inside the grant.
    for (const event of events.filter((line) => line.event === "granted")) {
      const lease = state.leases[event.lease].lease
      assert.equal(input.type, "source-answer", `${where}: a capable lease without its device's yes`)
      assert.equal(input.answer.answer, "yes")
      assert.equal(lease.device, before.asks[input.ask].device, `${where}: a lease on a device other than the one asked`)
      assert.ok(reachesBorrower(state.grants[lease.grant].grant, lease.borrower), `${where}: a lease outside its grant`)
      assert.ok(lease.session?.state === "starting", `${where}: an operation lease without its session`)
    }
    // 10. Nothing waits that could be served now, and a capability's line keeps its order.
    for (const [key, wait] of Object.entries(state.waiting)) {
      const held = state.grants[wait.grant]
      assert.ok(held && !held.ended, `${where}: a need waits under an ended grant`)
      assert.ok(reachesBorrower(held.grant, wait.need.for) && selects(held.grant.resource, wait.need.kind, wait.need.ref), `${where}: ${key} waits under a grant that no longer reaches it`)
      assert.ok(!("device" in route(state, held.grant, wait.need, wait.excluded ?? [])), `${where}: ${key} waits though a device could take it`)
      // 11. A wait ends by its deadline, which is never more than a day.
      assert.ok(wait.deadline > at, `${where}: a wait outlived its deadline`)
      assert.ok(wait.deadline - wait.since <= WAIT_MAX_MS)
      for (const [, left] of Object.entries(before.waiting))
        if (!state.waiting[needKey(left.need.for, left.need.correlationId)] && left.grant === wait.grant && JSON.stringify(left.need.requires ?? []) === JSON.stringify(wait.need.requires ?? []) && JSON.stringify(left.excluded ?? []) === JSON.stringify(wait.excluded ?? []) && left.since > wait.since && state.asks[left.ask])
          assert.fail(`${where}: a later need for the same capability went first`)
    }
    // 11. Every wait that left the line ended typed: asked, or decided by a refusal said in words.
    for (const [key, left] of Object.entries(before.waiting)) {
      if (state.waiting[key]) continue
      const decided = result.effects.find((effect) => effect.effect === "push" && effect.push.push === "decided" && effect.push.correlationId === left.need.correlationId && effect.borrower.thread === left.need.for.thread)
      assert.ok(state.asks[left.ask] || decided, `${where}: a wait ended untold`)
      // 11. Never served late: a need past its deadline is refused, whatever room has come.
      if (state.asks[left.ask]) assert.ok(at < left.deadline, `${where}: ${key} was asked for after its deadline`)
      if (decided && "refusal" in decided.push.answer) assert.ok(["no-capable-device", "revoked", "expired", "thread-ended", "out-of-scope"].includes(decided.push.answer.refusal.refused), `${where}: a wait ended as ${decided.push.answer.refusal.refused}`)
    }
    // 12. Sessions end: none outlives its heartbeats, a cancel or its device going offline.
    for (const held of Object.values(state.leases)) {
      if (held.ended || !held.lease.session) continue
      assert.ok(at - held.lease.session.lastBeat <= SESSION_LOST_BEATS * held.lease.session.heartbeatMs, `${where}: a session outlived its heartbeats`)
      assert.ok(state.devices[held.lease.device]?.online, `${where}: a session lives on an offline device`)
    }
    if (input.type === "cancel" && before.leases[input.lease] && !before.leases[input.lease].ended) assert.ok(["cancelled", "lost", "expired"].includes(state.leases[input.lease].ended?.why), `${where}: a cancel left its session live`)
  }
}

describe("borrowing: capable devices keep rules 8 to 12 over generated sequences", () => {
  test("40 seeded walks of 500 steps route, wait, wake and end sessions as the rules say", () => {
    const tally = {}
    for (let seed = 1; seed <= 40; seed++) walkCapable(seed, 500, tally)
    for (const kind of ["queued", "asked", "granted", "cancelled", "lost", "refused"]) assert.ok((tally[`event:${kind}`] ?? 0) > 5, `too few ${kind}: ${JSON.stringify(tally)}`)
    assert.ok((tally.timedOut ?? 0) > 3, `too few waits reached their deadline: ${JSON.stringify(tally)}`)
    assert.ok((tally.waited ?? 0) > 10, "too few needs waited")
    for (const kind of ["wrongDevice", "told", "artifacts"]) assert.ok((tally[kind] ?? 0) > 5, `too few ${kind}: ${JSON.stringify(tally)}`)
  })
})

const mac = { account: ACCOUNT, repository: "acme/web", thread: "t1", place: { kind: "machine", machine: "m1" } }
const base = (overrides) =>
  GrantSchema.parse({
    id: "g",
    resource: { kind: "file", ref: ".env" },
    source: { kind: "vault" },
    scope: { level: "project", account: ACCOUNT, repository: "acme/web" },
    mode: "copy",
    access: "read",
    lifetime: { until: "revoked" },
    ask: "never",
    secret: true,
    grantedBy: { kind: "person", account: ACCOUNT },
    grantedAt: 1,
    version: 1,
    ...overrides,
  })
const need = (overrides = {}) => ({ kind: "file", ref: ".env", for: mac, why: "the dev server reads it", correlationId: "c1", ...overrides })

describe("borrowing: exact cases", () => {
  test("selectors: globs stay in a folder, ** crosses, trees cover what's under them, .. never matches", () => {
    assert.ok(selects({ kind: "file", ref: "config/*.json" }, "file", "config/dev.json"))
    assert.ok(!selects({ kind: "file", ref: "config/*.json" }, "file", "config/a/dev.json"))
    assert.ok(selects({ kind: "file", ref: "~/flage/**" }, "file", "~/flage/src/a.ts"))
    assert.ok(!selects({ kind: "file", ref: "**" }, "file", "../outside"))
    assert.ok(selects({ kind: "tree", ref: "~/flage/src" }, "tree", "~/flage/src/x/y.ts"))
    assert.ok(!selects({ kind: "tree", ref: "~/flage/src" }, "tree", "~/flage/srcx"))
    assert.ok(selects({ kind: "command", ref: "aws **" }, "command", "aws rds describe-db-instances"))
    assert.ok(selects({ kind: "command", ref: "op read *" }, "command", "op read x"))
    assert.ok(!selects({ kind: "command", ref: "op read *" }, "command", "op read x y"))
    assert.ok(!selects({ kind: "file", ref: ".env" }, "env", ".env"))
    assert.ok(selects({ kind: "tree", ref: "~/flage/src" }, "file", "~/flage/src/a.ts"), "a folder's grant covers the files in it")
    assert.ok(selects({ kind: "tree", ref: "**" }, "file", ".env"))
    assert.ok(!selects({ kind: "file", ref: "**" }, "tree", "fixtures"), "a file's grant never covers a folder")
  })

  test("a grant's kind decides its modes, and only a device asks or relays", () => {
    assert.throws(() => base({ mode: "relay" }))
    assert.throws(() => base({ ask: "first-use" }))
    assert.throws(() => base({ resource: { kind: "command", ref: "aws **" }, mode: "relay", access: "run" }))
    assert.throws(() => base({ lifetime: { until: "thread-ends" } }))
  })

  test("the narrowest grant wins a name", () => {
    let state = emptyBroker(ACCOUNT)
    state = step(state, { type: "grant", grant: base({ id: "wide", scope: { level: "account", account: ACCOUNT }, grantedAt: 5 }), at: 5 }).state
    state = step(state, { type: "grant", grant: base({ id: "narrow", scope: { level: "thread", account: ACCOUNT, thread: "t1" }, grantedAt: 2 }), at: 5 }).state
    const { answer } = step(state, { type: "borrow", need: need(), at: 6, lease: "l1", ask: "a1", content: { version: sha("x"), size: 1 } })
    assert.equal(answer.lease.grant, "narrow")
  })

  test("nothing granted asks the person for the narrowest scope, and a grant then answers the same need", () => {
    let state = emptyBroker(ACCOUNT)
    const first = step(state, { type: "borrow", need: need(), at: 1, lease: "l1", ask: "a1", content: { version: sha("x"), size: 1 } })
    assert.equal(first.answer.refusal.refused, "no-grant")
    assert.deepEqual(first.answer.refusal.ask.scope, { level: "thread", account: ACCOUNT, thread: "t1" })
    state = step(first.state, { type: "grant", grant: base(), at: 2 }).state
    const second = step(state, { type: "borrow", need: need(), at: 3, lease: "l2", ask: "a2", content: { version: sha("x"), size: 1 } })
    assert.equal(second.answer.lease.id, "l2")
  })

  test("a copy the borrower holds at this version moves nothing; a small one goes inline, a large one as chunks", () => {
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: base(), at: 1 }).state
    const version = sha("x")
    const held = step(state, { type: "borrow", need: need({ holding: { version, at: 0 } }), at: 2, lease: "l1", ask: "a1", content: { version, size: 10 } })
    assert.equal(held.answer.lease.delivery.transfer, "none")
    const small = step(held.state, { type: "borrow", need: need({ correlationId: "c2" }), at: 2, lease: "l2", ask: "a2", content: { version, size: 10 } })
    assert.equal(small.answer.lease.delivery.transfer, "inline")
    const large = step(small.state, { type: "borrow", need: need({ correlationId: "c3" }), at: 2, lease: "l3", ask: "a3", content: { version, size: 10_000_000 } })
    assert.equal(large.answer.lease.delivery.transfer, "chunks")
    assert.equal(large.answer.lease.delivery.secret, true)
  })

  test("a device source asks first, answers a waiting need by push, and serves a stale copy only to whom it said yes", () => {
    const device = base({ id: "mac-src", source: { kind: "device", device: "mac" }, ask: "first-use", resource: { kind: "tree", ref: "~/flage/src" }, secret: false })
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: device, at: 1 }).state
    state = step(state, { type: "device", device: "mac", online: true, at: 1 }).state
    const tree = need({ kind: "tree", ref: "~/flage/src" })
    const asked = step(state, { type: "borrow", need: tree, at: 2, lease: "l1", ask: "a1" })
    assert.equal(asked.answer.pending, "source")
    assert.equal(asked.effects.find((effect) => effect.effect === "ask").ask.askPerson, true)
    const yes = step(asked.state, { type: "source-answer", ask: "a1", answer: { answer: "yes", version: sha("tree"), size: 2_000 }, at: 3 })
    assert.equal(yes.answer.lease.version, sha("tree"))
    assert.ok(yes.effects.some((effect) => effect.effect === "push" && effect.push.push === "decided" && effect.push.correlationId === "c1"))
    assert.deepEqual(step(yes.state, { type: "borrow", need: tree, at: 4, lease: "x", ask: "x" }).answer, yes.answer)
    const again = step(yes.state, { type: "borrow", need: { ...tree, correlationId: "c2" }, at: 4, lease: "l2", ask: "a2" })
    assert.equal(again.effects.find((effect) => effect.effect === "ask").ask.askPerson, false, "first-use asks the person once per borrower")
    state = step(again.state, { type: "device", device: "mac", online: false, at: 5 }).state
    const stale = step(state, { type: "borrow", need: { ...tree, correlationId: "c3", holding: { version: sha("tree"), at: 3 } }, at: 6, lease: "l3", ask: "a3" })
    assert.deepEqual(stale.answer.lease.stale, { heldSince: 3, sourceLastSeen: 1 })
    const stranger = { ...mac, thread: "t2" }
    const refused = step(stale.state, { type: "borrow", need: { ...tree, for: stranger, correlationId: "c4", holding: { version: sha("tree"), at: 3 } }, at: 6, lease: "l4", ask: "a4" })
    assert.equal(refused.answer.refusal.refused, "source-offline")
    assert.equal(refused.answer.refusal.cached.version, sha("tree"))
  })

  test("a grant given once is spent by its first lease; one that ends with its Thread ends with it", () => {
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: base({ lifetime: { until: "once" } }), at: 1 }).state
    state = step(state, { type: "borrow", need: need(), at: 2, lease: "l1", ask: "a1", content: { version: sha("x"), size: 1 } }).state
    assert.equal(step(state, { type: "borrow", need: need({ correlationId: "c2" }), at: 3, lease: "l2", ask: "a2", content: { version: sha("x"), size: 1 } }).answer.refusal.refused, "revoked")
    state = step(emptyBroker(ACCOUNT), { type: "grant", grant: base({ scope: { level: "thread", account: ACCOUNT, thread: "t1" }, lifetime: { until: "thread-ends" } }), at: 1 }).state
    state = step(state, { type: "borrow", need: need(), at: 2, lease: "l1", ask: "a1", content: { version: sha("x"), size: 1 } }).state
    const ended = step(state, { type: "thread-ended", account: ACCOUNT, thread: "t1", at: 3 })
    assert.equal(liveLeases(ended.state).length, 0)
    assert.equal(standingGrants(ended.state, 3).length, 0)
  })

  test("narrowing a grant's scope ends the leases it no longer reaches", () => {
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: base(), at: 1 }).state
    state = step(state, { type: "borrow", need: need(), at: 2, lease: "l1", ask: "a1", content: { version: sha("x"), size: 1 } }).state
    const narrowed = step(state, { type: "grant", grant: base({ version: 2, scope: { level: "thread", account: ACCOUNT, thread: "t9" } }), at: 3 })
    assert.equal(liveLeases(narrowed.state).length, 0)
    assert.ok(narrowed.effects.some((effect) => effect.effect === "push" && effect.push.push === "ended"))
    assert.ok(narrowed.effects.some((effect) => effect.effect === "unreferenced"))
  })

  test("a grant that keeps to its device reaches only borrowers there, and a need's mode picks the grant", () => {
    const here = { ...mac, place: { kind: "device", device: "mac" } }
    const local = base({ id: "local-copy", source: { kind: "device", device: "mac" }, resource: { kind: "tree", ref: "**" }, within: "source-device", secret: false })
    const linked = base({ id: "local-link", source: { kind: "device", device: "mac" }, resource: { kind: "tree", ref: "**" }, within: "source-device", mode: "live", secret: false })
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: local, at: 1 }).state
    state = step(state, { type: "grant", grant: linked, at: 1 }).state
    state = step(state, { type: "device", device: "mac", online: true, at: 1 }).state
    const away = step(state, { type: "borrow", need: need({ kind: "tree", ref: "node_modules" }), at: 2, lease: "l1", ask: "a1" })
    assert.equal(away.answer.refusal.refused, "out-of-scope", "a cloud machine doesn't reach a grant that keeps to the Mac")
    const live = step(state, { type: "borrow", need: need({ kind: "tree", ref: "node_modules", for: here, mode: "live" }), at: 2, lease: "l2", ask: "a2" })
    assert.equal(live.effects.find((effect) => effect.effect === "ask").ask.grant, "local-link")
    const copy = step(state, { type: "borrow", need: need({ kind: "tree", ref: "node_modules", for: here, mode: "copy" }), at: 2, lease: "l3", ask: "a3" })
    assert.equal(copy.effects.find((effect) => effect.effect === "ask").ask.grant, "local-copy")
    assert.throws(() => base({ within: "source-device" }), "only a device's grant keeps to it")
  })

  test("a Thread that ends while a device decides gets nothing from the device's late yes", () => {
    const device = base({ id: "mac-src", source: { kind: "device", device: "mac" }, scope: { level: "account", account: ACCOUNT }, ask: "first-use", resource: { kind: "tree", ref: "~/flage/src" }, secret: false })
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: device, at: 1 }).state
    state = step(state, { type: "device", device: "mac", online: true, at: 1 }).state
    const need = { kind: "tree", ref: "~/flage/src", for: mac, why: "read it", correlationId: "c1" }
    state = step(state, { type: "borrow", need, at: 2, lease: "l1", ask: "a1" }).state
    const ended = step(state, { type: "thread-ended", account: ACCOUNT, thread: mac.thread, at: 3 })
    assert.ok(ended.effects.some((effect) => effect.effect === "push" && effect.push.push === "decided" && effect.push.answer.refusal?.refused === "thread-ended"), "the waiting need ends with its Thread")
    const late = step(ended.state, { type: "source-answer", ask: "a1", answer: { answer: "yes", version: sha("tree") }, at: 4 })
    assert.ok(late.rejected, "the ask is gone")
    assert.equal(liveLeases(late.state).length, 0)
    const again = step(late.state, { type: "borrow", need: { ...need, correlationId: "c2" }, at: 5, lease: "l2", ask: "a2" })
    assert.equal(again.answer.refusal.refused, "thread-ended", "and a need it sends after is refused")
  })

  test("a source's failure reaches the borrower as a fixed reason, never the source's words", () => {
    const device = base({ id: "mac-src", source: { kind: "device", device: "mac" }, ask: "never", resource: { kind: "file", ref: ".env" } })
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: device, at: 1 }).state
    state = step(state, { type: "device", device: "mac", online: true, at: 1 }).state
    state = step(state, { type: "borrow", need: need(), at: 2, lease: "l1", ask: "a1" }).state
    const failed = step(state, { type: "source-answer", ask: "a1", answer: { answer: "unavailable", reason: "unreadable" }, at: 3 })
    assert.deepEqual(failed.answer, { refusal: { refused: "unavailable", reason: "unreadable" } })
    assert.equal(SourceAnswerSchema.safeParse({ answer: "unavailable", detail: "API_KEY=sk-live" }).success, false, "a source's own words aren't an answer")
    const leaked = step(state, { type: "source-answer", ask: "a1", answer: { answer: "unavailable", detail: "API_KEY=sk-live" }, at: 3 })
    assert.ok(!JSON.stringify([leaked.answer ?? null, leaked.effects]).includes("sk-live"), "nor do they reach an answer, a push or the log")
  })

  test("an ended Thread stays ended however long after: a fresh need under an account grant is refused", () => {
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: base({ scope: { level: "account", account: ACCOUNT } }), at: 1 }).state
    state = step(state, { type: "thread-ended", account: ACCOUNT, thread: mac.thread, at: 2 }).state
    const late = step(state, { type: "borrow", need: need({ correlationId: "after-a-year" }), at: 2 + 400 * 24 * 60 * 60_000, lease: "l1", ask: "a1", content: { version: sha("x"), size: 1 } })
    assert.equal(late.answer.refusal?.refused, "thread-ended")
    assert.equal(liveLeases(late.state).length, 0)
  })

  test("a long-lived broker keeps only what's live: ended leases and their answers retire", () => {
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: base(), at: 1 }).state
    let at = 10
    for (let index = 0; index < 5000; index++) {
      at += 60 * 60_000
      const taken = step(state, { type: "borrow", need: need({ correlationId: `c${index}` }), at, lease: `l${index}`, ask: `a${index}`, content: { version: sha("x"), size: 1 } })
      state = step(taken.state, { type: "release", lease: `l${index}`, at }).state
    }
    assert.ok(Object.keys(state.leases).length <= 24 * 7 + 1, `${Object.keys(state.leases).length} leases kept`)
    assert.ok(Object.keys(state.answers).length <= 24 * 7 + 1, `${Object.keys(state.answers).length} answers kept`)
  })

  test("a cloud Thread's simulator waits for a busy Mac, starts the moment a slot frees, runs on heartbeats and is lost without them", () => {
    const simulators = GrantSchema.parse({
      id: "sims", resource: { kind: "operation", ref: "ios-simulator.*" }, source: { kind: "capable", requires: [{ capability: "ios-simulator", where: { runtime: "iOS 26.*" } }] },
      scope: { level: "project", account: ACCOUNT, repository: "acme/web" }, mode: "relay", access: "run", lifetime: { until: "revoked" }, ask: "first-use", secret: false,
      grantedBy: { kind: "person", account: ACCOUNT }, grantedAt: 1, version: 1,
    })
    const phone = { capability: "ios-simulator", version: "26.1", attributes: { runtime: "iOS 26.1", device: "iPhone 17" } }
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: simulators, at: 1 }).state
    state = step(state, { type: "advertise", device: "mac", capabilities: [phone], slots: { used: 6, of: 6 }, at: 2 }).state
    const need = { kind: "operation", ref: "ios-simulator.session", for: mac, why: "check the sign-up form", correlationId: "sim-1" }
    const waiting = step(state, { type: "borrow", need, at: 3, lease: "l1", ask: "a1" })
    assert.deepEqual(waiting.answer, { pending: "capacity", why: "all-busy", position: 1, since: 3, deadline: 3 + 30 * 60_000 })
    assert.ok(waiting.effects.some((effect) => effect.effect === "log" && effect.event.event === "queued"))
    assert.deepEqual(step(waiting.state, { type: "borrow", need, at: 4, lease: "x", ask: "x" }).answer.position, 1, "the same need is the same wait")
    const freed = step(waiting.state, { type: "advertise", device: "mac", capabilities: [phone], slots: { used: 5, of: 6 }, at: 60_000 })
    const asked = freed.effects.find((effect) => effect.effect === "ask")
    assert.equal(asked?.device, "mac", "a freed slot asks the Mac in the same step")
    assert.equal(asked.ask.askPerson, true, "first use asks the Mac's person")
    const yes = step(freed.state, { type: "source-answer", ask: "a1", answer: { answer: "yes", version: "v1" }, at: 61_000 })
    assert.equal(yes.answer.lease.device, "mac")
    assert.equal(yes.answer.lease.session.state, "starting")
    assert.ok(yes.effects.some((effect) => effect.effect === "push" && effect.push.push === "decided" && effect.push.correlationId === "sim-1"))
    assert.equal(step(yes.state, { type: "heartbeat", lease: "l1", device: "studio", at: 100_000 }).rejected, "Only the lease's device speaks for its session")
    const running = step(yes.state, { type: "heartbeat", lease: "l1", device: "mac", streams: [{ name: "screen", kind: "video" }], at: 100_000 })
    assert.equal(running.state.leases.l1.lease.session.state, "running")
    assert.deepEqual(running.state.leases.l1.lease.session.streams, [{ name: "screen", kind: "video" }], "the lease names what it streams")
    // A file the session made: by name, hash and size, from its own device; a path or another device's word isn't taken.
    const recording = { name: "sign-up.mov", hash: sha("recording"), size: 4_096 }
    const made = step(running.state, { type: "artifact", lease: "l1", device: "mac", artifact: recording, at: 101_000 })
    assert.deepEqual(made.state.leases.l1.lease.session.artifacts, [recording])
    for (const name of ["..", ".", "../secret", "tmp/out.mov", "a\\b"]) assert.ok(step(running.state, { type: "artifact", lease: "l1", device: "mac", artifact: { ...recording, name }, at: 101_000 }).rejected, `${name} isn't a file's name`)
    assert.ok(step(running.state, { type: "artifact", lease: "l1", device: "studio", artifact: recording, at: 101_000 }).rejected)
    const lost = step(made.state, { type: "tick", at: 101_000 + 4 * 60_000 })
    assert.equal(lost.state.leases.l1.ended.why, "lost")
    assert.ok(lost.effects.some((effect) => effect.effect === "push" && effect.push.push === "ended" && effect.push.why === "lost"))
    assert.deepEqual(lost.effects.filter((effect) => effect.effect === "tell"), [{ effect: "tell", device: "mac", push: { push: "ended", lease: "l1", why: "lost" } }], "its device is told, once")
    assert.equal(lost.state.leases.l1.lease.session.artifacts, undefined, "an ended lease lists no files")
    assert.ok(lost.effects.some((effect) => effect.effect === "unreferenced" && effect.version === recording.hash), "and its files are let go")
    assert.ok(step(lost.state, { type: "artifact", lease: "l1", device: "mac", artifact: recording, at: 400_000 }).rejected, "nothing more is listed on an ended lease")
  })

  test("with no capable device online a need waits to its deadline and ends typed; a device that can't serve is passed over; the borrower's own device goes first", () => {
    const builds = GrantSchema.parse({
      id: "builds", resource: { kind: "operation", ref: "xcodebuild" }, source: { kind: "capable", requires: [{ capability: "xcode", version: "17.*" }] },
      scope: { level: "account", account: ACCOUNT }, mode: "relay", access: "run", lifetime: { until: "revoked" }, ask: "never", secret: false,
      grantedBy: { kind: "person", account: ACCOUNT }, grantedAt: 1, version: 1, devices: ["mac"],
    })
    const xcode = { capability: "xcode", version: "17.1" }
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: builds, at: 1 }).state
    state = step(state, { type: "advertise", device: "mac", capabilities: [xcode], slots: { used: 0, of: 2 }, at: 2 }).state
    state = step(state, { type: "device", device: "mac", online: false, at: 3 }).state
    const need = { kind: "operation", ref: "xcodebuild", for: mac, why: "build the app", correlationId: "b1", deadline: 3 + 10 * 60_000 }
    const offline = step(state, { type: "borrow", need, at: 4, lease: "l1", ask: "a1" })
    assert.equal(offline.answer.why, "no-device-online")
    const late = step(offline.state, { type: "tick", at: 3 + 10 * 60_000 })
    const ended = late.effects.find((effect) => effect.effect === "push" && effect.push.push === "decided")
    assert.deepEqual(ended.push.answer, { refusal: { refused: "no-capable-device", why: "no-device-online", waited: 10 * 60_000 - 1 } })
    assert.equal(Object.keys(late.state.waiting).length, 0)

    state = step(state, { type: "advertise", device: "mac", capabilities: [xcode], slots: { used: 0, of: 2 }, at: 5 }).state
    state = step(state, { type: "advertise", device: "studio", capabilities: [xcode], slots: { used: 0, of: 8 }, at: 5 }).state
    const here = { ...mac, place: { kind: "device", device: "mac" } }
    const own = step(state, { type: "borrow", need: { ...need, for: here, correlationId: "b2", deadline: undefined }, at: 6, lease: "l2", ask: "a2" })
    assert.equal(own.effects.find((effect) => effect.effect === "ask").device, "mac", "the borrower's own device first, though another has more room")
    const passed = step(own.state, { type: "source-answer", ask: "a2", answer: { answer: "unavailable", reason: "error" }, at: 7 })
    assert.equal(passed.effects.find((effect) => effect.effect === "ask")?.device, "studio", "a device that couldn't serve is passed over")
    const revoked = step(offline.state, { type: "revoke", grant: "builds", by: { kind: "person", account: ACCOUNT }, at: 8 })
    assert.equal(revoked.effects.find((effect) => effect.effect === "push" && effect.push.push === "decided").push.answer.refusal.refused, "revoked")
    assert.equal(Object.keys(revoked.state.waiting).length, 0, "a revoke ends what waits under it")
  })

  test("a need waiting under a grant that's narrowed away from it is refused, never issued under the new version", () => {
    const sims = GrantSchema.parse({
      id: "sims", resource: { kind: "operation", ref: "ios-simulator.*" }, source: { kind: "capable", requires: [{ capability: "ios-simulator" }], devices: ["studio"] },
      scope: { level: "thread", account: ACCOUNT, thread: "t1" }, mode: "relay", access: "run", lifetime: { until: "revoked" }, ask: "never", secret: false,
      grantedBy: { kind: "person", account: ACCOUNT }, grantedAt: 1, version: 1, devices: ["mac"],
    })
    const borrower = { ...mac, place: { kind: "device", device: "mac" } }
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: sims, at: 1 }).state
    state = step(state, { type: "borrow", need: { kind: "operation", ref: "ios-simulator.session", for: borrower, why: "drive it", correlationId: "w1" }, lease: "l1", ask: "a1", at: 2 }).state
    assert.equal(Object.keys(state.waiting).length, 1, "it waits: no capable device yet")
    const narrowed = step(state, { type: "grant", grant: { ...sims, version: 2, scope: { level: "thread", account: ACCOUNT, thread: "t2" } }, at: 3 })
    assert.equal(Object.keys(narrowed.state.waiting).length, 0, "the narrowed grant no longer reaches it, so it stops waiting")
    assert.equal(narrowed.effects.find((effect) => effect.effect === "push" && effect.push.push === "decided")?.push.answer.refusal?.refused, "out-of-scope")
    const woke = step(narrowed.state, { type: "advertise", device: "studio", capabilities: [{ capability: "ios-simulator", version: "27.2" }], slots: { used: 0, of: 1 }, at: 4 })
    assert.equal(woke.effects.filter((effect) => effect.effect === "ask").length, 0, "and a device with room later is asked nothing for it")
  })

  test("room that comes at or after a waiting need's deadline doesn't serve it: the need is refused, never served late", () => {
    const sims = GrantSchema.parse({
      id: "sims", resource: { kind: "operation", ref: "ios-simulator.*" }, source: { kind: "capable", requires: [{ capability: "ios-simulator" }] },
      scope: { level: "account", account: ACCOUNT }, mode: "relay", access: "run", lifetime: { until: "revoked" }, ask: "never", secret: false,
      grantedBy: { kind: "person", account: ACCOUNT }, grantedAt: 1, version: 1,
    })
    for (const late of [100, 101]) {
      let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: sims, at: 1 }).state
      state = step(state, { type: "borrow", need: { kind: "operation", ref: "ios-simulator.session", for: mac, why: "drive it", correlationId: "d1", deadline: 100 }, lease: "l1", ask: "a1", at: 2 }).state
      const room = step(state, { type: "advertise", device: "studio", capabilities: [{ capability: "ios-simulator", version: "27.2" }], slots: { used: 0, of: 1 }, at: late })
      assert.equal(room.effects.filter((effect) => effect.effect === "ask").length, 0, `room at ${late} asks nothing`)
      assert.equal(room.effects.find((effect) => effect.effect === "push" && effect.push.push === "decided")?.push.answer.refusal?.refused, "no-capable-device", `at ${late} the need is refused`)
    }
  })

  test("a borrower at a device is reached only by a grant naming that device, or one that keeps to it; a machine as before", () => {
    const vault = base({ scope: { level: "project", account: ACCOUNT, repository: "acme/web" } })
    const atMac = { ...mac, place: { kind: "device", device: "mac" } }
    const atStudio = { ...mac, place: { kind: "device", device: "studio" } }
    assert.equal(reachesBorrower(vault, mac), true, "a machine of the project")
    assert.equal(reachesBorrower(vault, atMac), false, "a device the grant doesn't name")
    const named = base({ devices: ["mac"] })
    assert.equal(reachesBorrower(named, atMac), true, "the device it names")
    assert.equal(reachesBorrower(named, atStudio), false, "and no other")
    const own = base({ source: { kind: "device", device: "mac" }, within: "source-device" })
    assert.equal(reachesBorrower(own, atMac), true, "a grant that keeps to its device reaches borrowers there")
    assert.throws(() => base({ source: { kind: "device", device: "mac" }, within: "source-device", devices: ["studio"] }), /keeps to its device/)
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: vault, at: 1 }).state
    assert.equal(step(state, { type: "borrow", need: need({ for: atMac }), lease: "l1", ask: "a1", at: 2, content: { version: sha("x"), size: 1 } }).answer.refusal?.refused, "out-of-scope")
    state = step(state, { type: "grant", grant: { ...named, version: 2 }, at: 3 }).state
    const lent = step(state, { type: "borrow", need: need({ for: atMac }), lease: "l2", ask: "a2", at: 4, content: { version: sha("x"), size: 1 } })
    assert.ok("lease" in lent.answer, JSON.stringify(lent.answer))
    // The lease the device holds is refused again once the grant stops naming it, reused or not.
    const moved = step(lent.state, { type: "grant", grant: { ...named, version: 3, devices: ["studio"] }, at: 5 })
    assert.equal(moved.state.leases.l2.ended?.why, "revoked")
    assert.equal(step(moved.state, { type: "borrow", need: need({ for: atMac }), lease: "l3", ask: "a3", at: 6, content: { version: sha("x"), size: 1 } }).answer.refusal?.refused, "revoked")
  })

  test("a session's file shared with another live session stays until the last one naming it ends", () => {
    const simulators = GrantSchema.parse({
      id: "sims", resource: { kind: "operation", ref: "ios-simulator.*" }, source: { kind: "capable", requires: [{ capability: "ios-simulator" }] },
      scope: { level: "project", account: ACCOUNT, repository: "acme/web" }, mode: "relay", access: "run", lifetime: { until: "revoked" }, ask: "never", secret: false,
      grantedBy: { kind: "person", account: ACCOUNT }, grantedAt: 1, version: 1,
    })
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: simulators, at: 1 }).state
    state = step(state, { type: "advertise", device: "mac", capabilities: [{ capability: "ios-simulator", version: "27.2" }], slots: { used: 0, of: 4 }, at: 2 }).state
    for (const [index, thread] of ["t1", "t2"].entries()) {
      const need = { kind: "operation", ref: "ios-simulator.session", for: { ...mac, thread }, why: "drive it", correlationId: `s${index}` }
      state = step(state, { type: "borrow", need, at: 3, lease: `l${index}`, ask: `a${index}` }).state
      state = step(state, { type: "source-answer", ask: `a${index}`, answer: { answer: "yes", version: "v1" }, at: 4 }).state
      state = step(state, { type: "artifact", lease: `l${index}`, device: "mac", artifact: { name: "shot.png", hash: sha("same bytes"), size: 10 }, at: 5 }).state
    }
    const unreferenced = (effects) => effects.filter((effect) => effect.effect === "unreferenced" && effect.version === sha("same bytes"))
    const first = step(state, { type: "release", lease: "l0", at: 6 })
    assert.deepEqual(unreferenced(first.effects), [], "the other live session still names the file")
    assert.deepEqual(first.state.leases.l1.lease.session.artifacts?.map((each) => each.hash), [sha("same bytes")])
    const last = step(first.state, { type: "release", lease: "l1", at: 7 })
    assert.equal(unreferenced(last.effects).length, 1, "the last one naming it lets it go")
  })

  test("a need's answer is its whole borrower's: the same Thread and correlation ID from another repository or place is decided afresh", () => {
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: base(), at: 1 }).state
    const first = step(state, { type: "borrow", need: need(), lease: "l1", ask: "a1", at: 2, content: { version: sha("x"), size: 1 } })
    assert.ok("lease" in first.answer, JSON.stringify(first.answer))
    state = first.state
    const otherRepository = step(state, { type: "borrow", need: need({ for: { ...mac, repository: "acme/other" } }), lease: "l2", ask: "a2", at: 3, content: { version: sha("x"), size: 1 } })
    assert.equal(otherRepository.answer.refusal?.refused, "out-of-scope", "another repository isn't handed the first one's lease")
    const otherMachine = step(state, { type: "borrow", need: need({ for: { ...mac, place: { kind: "machine", machine: "m2" } } }), lease: "l3", ask: "a3", at: 4, content: { version: sha("x"), size: 1 } })
    assert.ok("lease" in otherMachine.answer && otherMachine.answer.lease.id === "l3", "another machine of the project gets a lease of its own, not the first one's")
    const again = step(state, { type: "borrow", need: need(), lease: "l4", ask: "a4", at: 5, content: { version: sha("x"), size: 1 } })
    assert.equal(again.answer.lease?.id, "l1", "the same borrower asking again still gets its own")
  })

  test("one seal context for every borrowed value", () => {
    assert.equal(borrowSealContext("a", "g", "v"), "mako.borrow.v1\0a\0g\0v")
  })
})

/**
 * The conformance suite holds brokers to account: an honest adapter over the core passes its device cases, and an
 * adapter that leaks fails them. Each leaky one is a way a real device route could go wrong.
 */
describe("borrowing: the conformance suite fails a broker that leaks to a device", async () => {
  const { runBorrowConformance } = await import("../dist/borrow-conformance.js")
  const DEVICE_CASES = ["a device borrows only", "a lease held under a grant that changed"]

  /** A broker over the pure core, serving device borrowers as an adapter would; `leak` names how it goes wrong. */
  function adapter(leak) {
    let state = emptyBroker("acct-c")
    let at = 1
    let serial = 0
    const values = new Map()
    return {
      async person() {
        return {
          account: "acct-c",
          device: "conformance-person",
          async grant(given, value) {
            const grant = { ...given, grantedBy: { kind: "person", account: "acct-c" }, grantedAt: at++ }
            const result = step(state, { type: "grant", grant, at: at++ })
            if (result.rejected) return 400
            state = result.state
            values.set(`${grant.id}\0${grant.version}`, value)
            return grant
          },
        }
      },
      async deviceBorrower(repository, device, listed) {
        const borrower = { account: "acct-c", repository, thread: listed ? `listed-${device}` : `unlisted-${serial++}`, place: { kind: "device", device } }
        return {
          borrower,
          async borrow(need) {
            // The listing is checked where the device's credential is served, before the core is asked.
            if (!listed && leak !== "issues-unlisted") return { refusal: { refused: "out-of-scope" } }
            const grant = Object.values(state.grants).find((held) => held.grant.resource.ref === need.ref)?.grant
            const result = step(state, { type: "borrow", need: { ...need, for: borrower }, lease: `l${serial++}`, ask: `a${serial++}`, at: at++, content: { version: sha("v"), size: 1 } })
            state = result.state
            if (leak === "hands-back-cached" && "refusal" in result.answer && grant) {
              const old = Object.values(state.leases).find((held) => held.lease.borrower.thread === borrower.thread)
              if (old) return { lease: old.lease }
            }
            return result.answer
          },
          async value(lease) {
            const held = state.leases[lease]
            const own = held && held.lease.borrower.thread === borrower.thread && !held.ended
            // The reviewer's leak: an unlisted Thread is refused a lease, but reads the listed one's value.
            if (!own && !(leak === "lets-unlisted-read" && !listed)) return 404
            return held ? values.get(`${held.lease.grant}\0${held.lease.grantVersion}`) ?? 404 : 404
          },
        }
      },
      async close() {},
    }
  }

  async function run(leak) {
    const cases = []
    runBorrowConformance(async () => adapter(leak), (name, body) => {
      if (DEVICE_CASES.some((wanted) => name.includes(wanted))) cases.push({ name, body })
    })
    assert.equal(cases.length, 2)
    const failed = []
    for (const { name, body } of cases) await body().catch(() => failed.push(name))
    return failed
  }

  test("an honest broker passes both device cases", async () => {
    assert.deepEqual(await run(undefined), [])
  })
  const caught = { "lets-unlisted-read": DEVICE_CASES[0], "issues-unlisted": DEVICE_CASES[0], "hands-back-cached": DEVICE_CASES[1] }
  for (const [leak, by] of Object.entries(caught))
    test(`a broker that ${leak.replaceAll("-", " ")} fails "${by}"`, async () => {
      const failed = await run(leak)
      assert.ok(failed.some((name) => name.includes(by)), `${leak} passed "${by}": ${JSON.stringify(failed)}`)
    })
})


describe("borrowing: canonical identity and persisted migration", () => {
  const oldKey = (forWhom, correlation) => `${forWhom.account}\0${forWhom.repository}\0${forWhom.thread}\0${forWhom.place.kind}:${forWhom.place.kind === "device" ? forWhom.place.device : forWhom.place.machine}\0${correlation}`
  const a = { ...mac, place: { kind: "machine", machine: "m1\0extra" } }
  const b = { ...mac, place: { kind: "machine", machine: "m1" } }
  const needA = () => NeedSchema.parse(need({ for: a, correlationId: "last" }))
  const needB = () => NeedSchema.parse(need({ for: b, correlationId: "extra\0last" }))
  const content = { version: sha("x"), size: 1 }
  const request = (state, wanted, lease, at = 2) => step(state, { type: "borrow", need: wanted, lease, ask: `ask-${lease}`, at, content })
  const granted = () => step(emptyBroker(ACCOUNT), { type: "grant", grant: base(), at: 1 }).state
  const pending = () => {
    let state = step(emptyBroker(ACCOUNT), { type: "grant", grant: base({ source: { kind: "device", device: "source" }, ask: "first-use" }), at: 1 }).state
    state = step(state, { type: "device", device: "source", online: true, at: 2 }).state
    const result = request(state, needA(), "reserved", 3)
    assert.equal(result.answer.pending, "source")
    return { ...result.state, answers: { [oldKey(a, "last")]: result.answer } }
  }
  const queued = (wanted = needA()) => {
    const grant = base({ resource: { kind: "operation", ref: "ios-simulator.*" }, source: { kind: "capable", requires: [{ capability: "ios-simulator" }] }, mode: "relay", access: "run", secret: false })
    const state = step(emptyBroker(ACCOUNT), { type: "grant", grant, at: 1 }).state
    const operation = NeedSchema.parse({ ...wanted, kind: "operation", ref: "ios-simulator.session" })
    const result = request(state, operation, "queued", 2)
    assert.equal(result.answer.pending, "capacity")
    const wait = Object.values(result.state.waiting)[0]
    return { state: result.state, operation, wait }
  }
  const room = (state, at = 10) => step(state, { type: "advertise", device: "source", capabilities: [{ capability: "ios-simulator" }], slots: { used: 0, of: 1 }, at })

  test("accepted delimiter counterexample issues each place its own lease", () => {
    assert.equal(BorrowerSchema.safeParse(a).success, true)
    assert.equal(BorrowerSchema.safeParse(b).success, true)
    assert.equal(oldKey(a, "last"), oldKey(b, "extra\0last"), "the old accepted-input counterexample")
    const first = request(granted(), needA(), "original")
    const second = request(first.state, needB(), "other", 3)
    assert.equal(second.answer.lease?.id, "other", "the other valid place must not get the original lease")
    assert.deepEqual(second.answer.lease.borrower, b)
    assert.notEqual(needKey(a, "last"), needKey(b, "extra\0last"))
  })

  test("tuple encoding distinguishes empty helper fields, tags, NUL, quotes, slashes and Unicode escapes", () => {
    const values = ["", "\0", "\\u0000", "a:b", 'a"b', "a\\b", "\n", "[\"machine\",\"x\"]", "😀", "\ud800"]
    const seen = new Map()
    for (let field = 0; field < 6; field++) for (const value of values) {
      const tuple = ["acct", "repo", "thread", "machine", "place", "correlation"]
      tuple[field] = field === 3 ? "device" : value
      const who = { account: tuple[0], repository: tuple[1], thread: tuple[2], place: tuple[3] === "device" ? { kind: "device", device: tuple[4] } : { kind: "machine", machine: tuple[4] } }
      const key = needKey(who, tuple[5]), identity = JSON.stringify(tuple)
      assert.equal(key.includes("\0"), false, "a current key cannot be a NUL-separated old key")
      if (seen.has(key)) assert.equal(seen.get(key), identity)
      seen.set(key, identity)
      assert.equal(needKey(structuredClone(who), tuple[5]), key)
    }
    assert.equal(BorrowerSchema.safeParse({ ...mac, account: "" }).success, false)
    assert.equal(NeedSchema.safeParse(need({ correlationId: "" })).success, false)
  })

  test("ordinary same-borrower restart replay and repository/place isolation stay intact", () => {
    const first = request(granted(), need(), "same")
    const state = JSON.parse(JSON.stringify(first.state))
    assert.equal(request(state, need(), "retry", 3).answer.lease.id, "same")
    assert.equal(request(state, need({ for: { ...mac, repository: "other/repo" } }), "foreign", 4).answer.refusal.refused, "out-of-scope")
    assert.equal(request(state, need({ for: { ...mac, place: { kind: "machine", machine: "other" } } }), "other", 5).answer.lease.id, "other")
  })

  test("legacy lease answer recovers only its structured borrower/correlation, never the collided key", () => {
    const first = request(granted(), needA(), "original")
    const state = JSON.parse(JSON.stringify({ ...first.state, answers: { [oldKey(a, "last")]: first.answer } }))
    const before = JSON.stringify(state)
    const other = request(state, needB(), "other", 3)
    assert.equal(other.answer.lease.id, "other")
    assert.equal(request(other.state, needA(), "retry", 4).answer.lease.id, "original")
    assert.deepEqual(Object.keys(other.state.leases).sort(), ["original", "other"])
    assert.equal(Object.hasOwn(other.state.answers, oldKey(a, "last")), false)
    assert.equal(JSON.stringify(state), before, "migration is pure")
  })

  test("canonical lease answer wins a duplicate legacy cache without deleting either live lease", () => {
    const first = request(granted(), needA(), "old")
    const current = request({ ...first.state, answers: {} }, needA(), "current", 3)
    const mixed = { ...current.state, answers: { ...current.state.answers, [oldKey(a, "last")]: first.answer } }
    const result = request(mixed, needA(), "retry", 4)
    assert.equal(result.answer.lease.id, "current")
    assert.deepEqual(Object.keys(result.state.leases).sort(), ["current", "old"])
  })

  test("unattributed old declines and lease answers without their retained lease miss safely", () => {
    const declined = { refusal: { refused: "declined", by: { kind: "person", account: ACCOUNT } } }
    const state = { ...granted(), answers: { [oldKey(a, "last")]: declined } }
    assert.equal(request(state, needA(), "fresh").answer.lease.id, "fresh")
    const first = request(granted(), needA(), "gone")
    const orphan = { ...first.state, leases: {}, answers: { [oldKey(a, "last")]: first.answer } }
    assert.equal(request(orphan, needB(), "other", 3).answer.lease.id, "other")
    const canonical = { ...granted(), answers: { [needKey(a, "last")]: declined, [oldKey(a, "last")]: first.answer } }
    assert.equal(request(canonical, needA(), "retry").answer.refusal.refused, "declined")
  })

  test("legacy waiting Need preserves queue age, deadline and reserved ask/lease through restart", () => {
    const { state, operation, wait } = queued()
    const old = JSON.parse(JSON.stringify({ ...state, waiting: { [oldKey(a, "last")]: wait } }))
    const retry = request(old, operation, "replacement", 3)
    assert.equal(retry.answer.since, wait.since)
    assert.equal(retry.answer.deadline, wait.deadline)
    assert.equal(Object.keys(retry.state.waiting).length, 1)
    assert.deepEqual(retry.state.waiting[needKey(a, "last")], wait)
    const freed = room(retry.state)
    assert.equal(freed.effects.filter(x => x.effect === "ask").length, 1)
    assert.equal(freed.effects.find(x => x.effect === "ask").ask.ask, wait.ask)
    const issued = step(freed.state, { type: "source-answer", ask: wait.ask, answer: { answer: "yes" }, at: 11 })
    assert.equal(issued.answer.lease.id, wait.lease)
  })

  test("a colliding old waiting key cannot claim or overwrite the other place's queue slot", () => {
    const { state, wait } = queued()
    const old = { ...state, waiting: { [oldKey(a, "last")]: wait } }
    const operation = NeedSchema.parse({ ...needB(), kind: "operation", ref: "ios-simulator.session" })
    const other = request(old, operation, "other", 3)
    assert.equal(other.answer.position, 2)
    assert.equal(Object.keys(other.state.waiting).length, 2)
    assert.equal(other.state.waiting[needKey(a, "last")].lease, wait.lease)
    assert.equal(other.state.waiting[needKey(b, "extra\0last")].lease, "other")
  })

  test("canonical and legacy waiting duplicates keep one canonical reservation and one source ask", () => {
    const { state, wait } = queued()
    const mixed = { ...state, waiting: { ...state.waiting, [oldKey(a, "last")]: { ...wait, lease: "duplicate", ask: "duplicate" } } }
    const migrated = step(mixed, { type: "tick", at: 3 })
    assert.equal(Object.keys(migrated.state.waiting).length, 1)
    const freed = room(migrated.state)
    assert.equal(freed.effects.filter(x => x.effect === "ask").length, 1)
    assert.equal(freed.effects.find(x => x.effect === "ask").ask.ask, wait.ask)
  })

  test("a retained waiting Need is validated before rekeying", () => {
    const { state, wait } = queued()
    const corrupt = { ...wait, need: { ...wait.need, for: { ...a, account: 123 } } }
    const result = step({ ...state, waiting: { [oldKey(a, "last")]: corrupt } }, { type: "tick", at: 3 })
    assert.deepEqual(result.state.waiting, {})
    assert.equal(result.effects.some(x => x.effect === "ask"), false)
  })

  for (const retryFirst of [false, true]) test(`persisted legacy source ask completes with its reserved lease, retry first=${retryFirst}`, () => {
    let state = JSON.parse(JSON.stringify(pending()))
    if (retryFirst) {
      const retry = request(state, needA(), "duplicate", 4)
      assert.equal(retry.answer.ask, "ask-reserved")
      assert.equal(retry.effects.some(x => x.effect === "ask"), false)
      state = retry.state
    }
    const completed = step(state, { type: "source-answer", ask: "ask-reserved", answer: { answer: "yes", version: sha("x"), size: 1 }, at: 5 })
    assert.equal(completed.answer.lease.id, "reserved")
    assert.deepEqual(completed.answer.lease.borrower, a)
    assert.equal(request(completed.state, needA(), "retry", 6).answer.lease.id, "reserved")
    assert.equal(Object.keys(completed.state.asks).length, 0)
    assert.equal(Object.hasOwn(completed.state.answers, oldKey(a, "last")), false)
  })

  test("a persisted pending-source collision creates an independent ask for the other place", () => {
    const state = pending()
    const other = request(state, needB(), "other", 4)
    assert.equal(other.answer.ask, "ask-other")
    assert.equal(Object.keys(other.state.asks).length, 2)
    assert.equal(other.state.asks["ask-reserved"].leaseId, "reserved")
    const first = step(other.state, { type: "source-answer", ask: "ask-reserved", answer: { answer: "yes", version: sha("x"), size: 1 }, at: 5 })
    const second = step(first.state, { type: "source-answer", ask: "ask-other", answer: { answer: "yes", version: sha("x"), size: 1 }, at: 6 })
    assert.equal(first.answer.lease.id, "reserved")
    assert.equal(second.answer.lease.id, "other")
  })

  test("a canonical pending source answer wins a legacy duplicate and late duplicate yes is fenced", () => {
    const old = pending(), ask = old.asks["ask-reserved"]
    const mixed = { ...old, answers: { ...old.answers, [needKey(a, "last")]: old.answers[oldKey(a, "last")] }, asks: { ...old.asks, duplicate: { ...ask, ask: "duplicate", leaseId: "duplicate" } } }
    const retry = request(mixed, needA(), "replacement", 4)
    assert.equal(retry.answer.ask, "ask-reserved")
    assert.deepEqual(Object.keys(retry.state.asks), ["ask-reserved"])
    const late = step(retry.state, { type: "source-answer", ask: "duplicate", answer: { answer: "yes", version: sha("x"), size: 1 }, at: 5 })
    assert.ok(late.rejected)
    assert.deepEqual(late.state.leases, {})
  })

  test("a dangling legacy pending cache is not an eternal pending answer", () => {
    const old = pending()
    const result = request({ ...old, asks: {} }, needA(), "fresh", 4)
    assert.equal(result.answer.ask, "ask-fresh")
    assert.equal(Object.keys(result.state.asks).length, 1)
  })

  test("rolling legacy answer writes cannot override an existing canonical answer or cross borrowers", () => {
    const original = request(granted(), needA(), "original")
    const oldWrite = { ...original.state, answers: { ...original.state.answers, [oldKey(a, "last")]: original.answer } }
    const other = request(oldWrite, needB(), "other", 3)
    assert.equal(other.answer.lease.id, "other")
    const persisted = JSON.parse(JSON.stringify(other.state))
    persisted.answers[oldKey(b, "extra\0last")] = original.answer
    assert.equal(request(persisted, needB(), "retry", 4).answer.lease.id, "other")
    assert.equal(request(persisted, needA(), "retry", 4).answer.lease.id, "original")
  })
  test("legacy-only duplicate waits keep the core's code-unit queue tie break", () => {
    const { state, wait } = queued()
    const mixed = { ...state, waiting: {
      [`${a.account}\0${a.thread}\0last`]: { ...wait, ask: "A", lease: "upper" },
      [oldKey(a, "last")]: { ...wait, ask: "a", lease: "lower" },
    } }
    const result = step(mixed, { type: "tick", at: 3 })
    assert.equal(Object.keys(result.state.waiting).length, 1)
    assert.equal(result.state.waiting[needKey(a, "last")].ask, "A")
    assert.equal(result.state.waiting[needKey(a, "last")].lease, "upper")
  })

  test("a current source-pending reservation wins an older legacy lease answer", () => {
    const old = request(granted(), needA(), "old")
    let state = step(old.state, { type: "grant", grant: base({ version: 2, source: { kind: "device", device: "source" }, ask: "first-use" }), at: 3 }).state
    state = step(state, { type: "device", device: "source", online: true, at: 4 }).state
    const current = request({ ...state, answers: {} }, needA(), "current", 5)
    assert.equal(current.answer.pending, "source")
    const mixed = { ...current.state, answers: { ...current.state.answers, [oldKey(a, "last")]: old.answer } }
    const retry = request(mixed, needA(), "replacement", 6)
    assert.equal(retry.answer.ask, "ask-current")
    assert.equal(retry.effects.some(x => x.effect === "ask"), false)
    assert.ok(retry.state.asks["ask-current"])
  })

  test("recovering an expired legacy lease cache cannot renew its correlation", () => {
    const first = request(granted(), needA(), "expired")
    const ended = step(first.state, { type: "tick", at: first.answer.lease.expiresAt + 1 })
    const old = { ...ended.state, answers: { [oldKey(a, "last")]: first.answer } }
    const retried = request(old, needA(), "fresh", first.answer.lease.expiresAt + 2)
    assert.equal(retried.answer.refusal?.refused, "expired")
    assert.equal(retried.state.leases.fresh, undefined)
  })

  test("a canonical waiting reservation wins an older legacy lease answer", () => {
    const old = request(granted(), needA(), "old")
    const { state, wait, operation } = queued()
    const mixed = { ...state, leases: old.state.leases, answers: { [oldKey(a, "last")]: old.answer } }
    const retry = request(mixed, operation, "replacement", 3)
    assert.equal(retry.answer.pending, "capacity")
    assert.equal(retry.state.waiting[needKey(a, "last")].lease, wait.lease)
    assert.ok(retry.state.leases.old, "the old live lease remains separately held")
  })

  test("a canonical waiting reservation wins a duplicate legacy pending-source record", () => {
    const { state, wait, operation } = queued()
    const old = room(state).state
    const mixed = { ...state, answers: { [oldKey(a, "last")]: old.answers[needKey(a, "last")] }, asks: old.asks }
    const retry = request(mixed, operation, "replacement", 3)
    assert.equal(retry.answer.pending, "capacity")
    assert.equal(retry.state.waiting[needKey(a, "last")].lease, wait.lease)
    assert.deepEqual(retry.state.asks, {})
  })

  test("a legacy writer completing a canonical pending ask is recovered from the retained lease", () => {
    const waiting = pending()
    waiting.answers[needKey(a, "last")] = waiting.answers[oldKey(a, "last")]
    const completed = step(waiting, { type: "source-answer", ask: "ask-reserved", answer: { answer: "yes", version: sha("x"), size: 1 }, at: 5 })
    // The old writer preserves unknown canonical keys but completes under its old key.
    const oldWrite = { ...completed.state, answers: { [needKey(a, "last")]: waiting.answers[needKey(a, "last")], [oldKey(a, "last")]: completed.answer } }
    const retry = request(JSON.parse(JSON.stringify(oldWrite)), needA(), "duplicate", 6)
    assert.equal(retry.answer.lease?.id, "reserved")
    assert.deepEqual(retry.state.asks, {})
    assert.equal(retry.effects.some(x => x.effect === "ask"), false)
    assert.deepEqual(Object.keys(retry.state.leases), ["reserved"])
  })

})
