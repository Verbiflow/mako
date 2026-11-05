import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, test } from "node:test"
import {
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
  grantExpiry,
  inScope,
  liveLeases,
  reachesBorrower,
  selects,
  standingGrants,
  step,
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

function grant(random, id, at) {
  const kind = random.pick(KINDS)
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
      const kind = random.pick(KINDS)
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
      const key = `${input.need.for.account}\0${input.need.for.thread}\0${input.need.correlationId}`
      const first = leaseByNeed.get(key)
      const firstHeld = first && state.leases[first.lease.id]
      const firstLive = firstHeld && !firstHeld.ended
      if (firstLive) assert.deepEqual(result.answer, first, `${where}: the same need answered twice differently`)
      else if (firstHeld) assert.ok(["expired", "revoked", "thread-ended"].includes(result.answer.refusal?.refused), `${where}: an ended lease answered again`)
      else if (result.answer && "lease" in result.answer) leaseByNeed.set(key, result.answer)
    }
    for (const event of events.filter((line) => line.event === "granted")) {
      const key = `${event.borrower.account}\0${event.borrower.thread}\0${event.correlationId}`
      const earlier = grantedPerNeed.get(key)
      assert.ok(earlier === undefined || !before.leases[earlier], `${where}: one need given two leases`)
      grantedPerNeed.set(key, event.lease)
    }
    if (input.type === "source-answer" && result.answer && "lease" in result.answer) {
      const asked = before.asks[input.ask].need
      leaseByNeed.set(`${asked.for.account}\0${asked.for.thread}\0${asked.correlationId}`, result.answer)
    }

    // 7. Offline is typed.
    if (input.type === "borrow" && !result.rejected && !before.answers[`${input.need.for.account}\0${input.need.for.thread}\0${input.need.correlationId}`]) {
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

  test("one seal context for every borrowed value", () => {
    assert.equal(borrowSealContext("a", "g", "v"), "mako.borrow.v1\0a\0g\0v")
  })
})
