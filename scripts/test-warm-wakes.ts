import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HostJobs, JobDemand } from "@mako/host/base/host-jobs"
import { DIGEST_WAITS, WAKE_COALESCE_MS, WAKES_PER_MINUTE } from "@mako/host/contracts/children"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { ThreadEnvironment } from "@mako/host/contracts/thread-environments"
import { AppKeySchema } from "@mako/host/contracts/thread-environments"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { PRIOR_COST } from "@mako/host/conversations/fin-capacity"
import { FinCapacity } from "@mako/host/conversations/fin-capacity-host"
import { FinCostModel } from "@mako/host/conversations/fin-cost"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { swapFreeOf, type MacReading } from "@mako/host/conversations/mac-capacity"
import { WARM_CEILING, WARM_FLOOR, WARM_MOST_BYTES, WARM_RELIEF_MS, warmLimit, type WarmReading } from "@mako/host/conversations/warm-limit"
import { ACCOUNT_WATCH_JOB, keepAccountsFresh, WARM_FIRST_LOOK_MS, WARM_LOOK_MS, WARM_WATCH_JOB, watchWarmProviders } from "@mako/host/conversations/warm-watch"
import { keychainUnchangedSince } from "@mako/host/harnesses/accounts-common"
import { CREDENTIAL_HOLD_MS, CREDENTIAL_REFRESH_FOR_MS, CREDENTIAL_REFRESH_MS, CredentialRevisions } from "@mako/host/harnesses/credential-revisions"
import type { AdmittedLiveDriver, ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * Warm providers and early wakes (`npm run test:warm-wakes`), with fake hardware, readings, jobs and clocks:
 * - the number of idle providers kept warm, from a machine's memory and what a provider holds, by table;
 * - memory pressure lowering it to the floor, and the excess hibernating then, without a turn ending;
 * - a wake that starts as a message is on its way: `agents_send` to a sleeping Fin and a digest queued for a sleeping
 *   Apex, and none for a message that's refused or held;
 * - a wake inside the idle window starting with the Thread's values its launch read, and one past it reading again.
 */
const GB = 1024 ** 3
const root = mkdtempSync(join(tmpdir(), "mako-warm-wakes-"))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(5)
  }
}

// ── The rule, by table: memory, what a provider holds, Fins at work, pressure.
function ruleTable(): void {
  const at = (memoryGb: number, more: Partial<WarmReading> = {}): WarmReading => ({ hardware: { cores: 10, memoryBytes: memoryGb * GB }, providerBytes: PRIOR_COST.memoryBytes, working: 0, ...more })
  const now = 60 * 60_000
  const table: [what: string, reading: WarmReading, expected: number][] = [
    ["8 GB at rest", at(8), 2],
    ["16 GB at rest", at(16), 2],
    ["36 GB at rest", at(36), 3],
    ["64 GB at rest", at(64), 3],
    ["128 GB at rest holds no more than the 3 GB either", at(128), 3],
    ["8 GB under pressure", at(8, { pressedAt: now }), 2],
    ["16 GB under pressure", at(16, { pressedAt: now }), 2],
    ["36 GB under pressure", at(36, { pressedAt: now }), 2],
    ["64 GB under pressure", at(64, { pressedAt: now }), 2],
    ["36 GB, pressure read four minutes ago", at(36, { pressedAt: now - 4 * 60_000 }), 2],
    ["36 GB, pressure last read five minutes ago", at(36, { pressedAt: now - WARM_RELIEF_MS }), 3],
    ["36 GB with 8 Fins at work", at(36, { working: 8 }), 3],
    ["36 GB with 17 Fins at work", at(36, { working: 17 }), 2],
    ["64 GB with 30 Fins at work", at(64, { working: 30 }), 3],
    ["16 GB, a provider measured at 0.4 GB", at(16, { providerBytes: 0.4 * GB }), 3],
    ["36 GB, a provider measured at 0.4 GB", at(36, { providerBytes: 0.4 * GB }), 7],
    ["64 GB, a provider measured at 0.3 GB stops at the ceiling", at(64, { providerBytes: 0.3 * GB }), WARM_CEILING],
    ["36 GB, a provider measured at 2 GB", at(36, { providerBytes: 2 * GB }), 2],
    ["64 GB, a provider measured at 2 GB", at(64, { providerBytes: 2 * GB }), 2],
    ["a headless 16 GB box keeps a smaller reserve", { ...at(16), hardware: { cores: 4, memoryBytes: 16 * GB, headless: true } }, 2],
    ["a machine with less memory than the reserve", at(2), WARM_FLOOR],
  ]
  for (const [what, reading, expected] of table) assert.equal(warmLimit(reading, now), expected, what)
  // What a full pool holds at most, counted at a provider's cost: past the floor, never more than 3 GB on any machine.
  for (const memoryGb of [8, 16, 36, 64, 128, 512]) {
    const limit = warmLimit(at(memoryGb), now)
    assert.ok(limit === WARM_FLOOR || limit * PRIOR_COST.memoryBytes <= WARM_MOST_BYTES, `${memoryGb} GB holds no more than 3 GB of idle providers`)
  }
  for (const memoryGb of [8, 16, 36, 64]) {
    const limit = warmLimit(at(memoryGb), now)
    console.log(`warm limit: ${memoryGb} GB at rest ${limit} (at most ${(limit * PRIOR_COST.memoryBytes / GB).toFixed(1)} GB at ${PRIOR_COST.memoryBytes / GB} GB each), under pressure ${warmLimit(at(memoryGb, { pressedAt: now }), now)}`)
  }
}

// ── Capacity's reading for the rule, and its word of memory pressure, from fake readings and a fake clock.
async function capacityReads(): Promise<void> {
  let now = 1_000_000
  let reading: MacReading = { cores: 14, memoryBytes: 36 * GB }
  const capacity = new FinCapacity({ read: async () => reading, costs: new FinCostModel(), own: () => undefined, hardware: () => ({ cores: 14, memoryBytes: 36 * GB }), now: () => now })
  let heard = 0
  capacity.subscribeMemoryPressure(() => { heard += 1 })
  assert.deepEqual(capacity.warm(), { hardware: { cores: 14, memoryBytes: 36 * GB }, providerBytes: PRIOR_COST.memoryBytes, working: 0 }, "unread, it's the machine at rest at the prior cost")
  assert.equal(warmLimit(capacity.warm(), now), 3)
  await capacity.look()
  assert.equal(heard, 0, "a calm reading says nothing")
  await capacity.observe(17, { claude: 17 })
  assert.equal(capacity.warm().working, 17, "the engine's look counts the Fins at work")
  assert.equal(warmLimit(capacity.warm(), now), 2)
  await capacity.observe(0, {})
  reading = { ...reading, memoryPressure: true }
  await capacity.look()
  assert.equal(heard, 1, "a reading short of memory is heard as it's read, not once an average holds")
  assert.equal(warmLimit(capacity.warm(), now), WARM_FLOOR)
  reading = { cores: 14, memoryBytes: 36 * GB, swapFreeBytes: 100 * 1024 ** 2 }
  now += 10_000
  await capacity.observe(0, {})
  assert.equal(heard, 2, "swap nearly gone is memory pressure too, and the engine's look says so as well")
  assert.equal(capacity.atOnce(), 17, "one pressed reading leaves the Fins' number where the governor has it")
  reading = { cores: 14, memoryBytes: 36 * GB }
  now += WARM_RELIEF_MS - 1
  await capacity.look()
  assert.equal(warmLimit(capacity.warm(), now), WARM_FLOOR, "calm readings don't refill the pool until relief has held")
  now += 1
  assert.equal(warmLimit(capacity.warm(), now), 3, "and then it's the machine's own number again")
  assert.equal(heard, 2)
  console.log("capacity: the warm reading follows the engine's looks and its own, and pressure is heard at once")
}

/** A driver whose sessions are ready at once and whose turns end at once: every conversation it runs comes to rest warm. */
function restingDriver(owner: () => LiveConversations, folder: string, closed: string[], starts: { id: string; resume?: string; environment?: ThreadEnvironment }[]): ProviderLiveDriver {
  return {
    ...noCapabilities,
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    resume: fixtureResume(),
    provider: "test-provider",
    available: () => true,
    start: async (_cwd, options) => {
      starts.push({ id: options.conversationId, ...(options.resume && { resume: options.resume }), ...(options.threadEnvironment && { environment: options.threadEnvironment }) })
      return { id: options.conversationId, nativeId: options.conversationId, nativePath: join(folder, options.conversationId), harness: "test-provider", cwd: folder, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }
    },
    prompt: async (id, _text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      const current = owner().snapshot(id)?.session
      assert.ok(current)
      owner().observe({ type: "live-session", session: { ...current, status: "running" } })
      owner().observe({ type: "live-session", session: { ...current, status: "ready" } })
    },
    permission: async () => {},
    cancel: async () => {},
    close: (id) => {
      closed.push(id)
    },
    setMode: async () => {},
  }
}

async function seeded(owner: LiveConversations, folder: string, id: string): Promise<void> {
  await owner.start("test-provider", folder, { conversationId: id, title: "A thread" })
  const request = randomUUID()
  owner.submit(id, request, "seed")
  await until("a seed turn", () => owner.snapshot(id)?.requests.some((asked) => asked.id === request && asked.status === "completed") === true)
}

// ── The pool follows the number as it's read at each decision; pressure lets the excess go at once.
async function pressureShrinksThePool(): Promise<void> {
  const folder = mkdtempSync(join(root, "pool-"))
  const closed: string[] = []
  let now = 5_000_000
  let pressedAt: number | undefined
  const kept: number[] = []
  const machine = (): WarmReading => ({ hardware: { cores: 14, memoryBytes: 36 * GB }, providerBytes: 0.75 * GB, working: 0, ...(pressedAt !== undefined && { pressedAt }) })
  let owner: LiveConversations
  const driver = restingDriver(() => owner, folder, closed, [])
  owner = new LiveConversations({
    appPath: folder, root: join(folder, "journals"), driver: () => driver, history: async () => null, emit: () => {},
    providerIdleMs: 60 * 60_000, now: () => now,
    warmLimit: () => warmLimit(machine(), now), warmKept: (count) => kept.push(count),
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  })
  const ids = Array.from({ length: 5 }, () => randomUUID())
  const connection = (id: string) => owner.snapshot(id)?.session.connection
  try {
    for (const id of ids) {
      await seeded(owner, folder, id)
      now += 1_000
    }
    await until("the fifth to push the oldest out", () => connection(ids[0]!) === "hibernated")
    assert.deepEqual(closed, [ids[0]], "a 36 GB machine keeps four idle providers of 0.75 GB, not two")
    assert.equal(owner.residency().warmLimit, 4, "Diagnostics says the number in force")
    assert.equal(owner.warmProviders(), 4)
    assert.equal(kept.at(-1), 4, "the host hears how many stay warm, to read memory while they're past the floor")

    // One of the four is asked something: `canHibernate` protects it, whatever the pool does.
    owner.observe({ type: "live-permission", request: { id: "ask-1", observationId: randomUUID(), sessionId: ids[4]!, title: "Run it?", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } })
    assert.equal(owner.snapshot(ids[4]!)?.permissions.length, 1)
    assert.equal(owner.warmProviders(), 3)

    // Memory pressure is read. No turn ends: the excess goes at the reading.
    pressedAt = now
    owner.memoryPressed()
    await until("the excess to hibernate", () => connection(ids[1]!) === "hibernated")
    assert.deepEqual(closed, [ids[0], ids[1]], "only the longest idle one past the floor of two goes")
    assert.equal(connection(ids[2]!), "connected")
    assert.equal(connection(ids[3]!), "connected")
    assert.equal(connection(ids[4]!), "connected", "a provider waiting on an answer is never closed for the pool")
    assert.equal(owner.residency().warmLimit, WARM_FLOOR)
    assert.equal(kept.at(-1), 2)

    // Pressure still read later closes nothing more: the floor is kept.
    owner.memoryPressed()
    await pause(30)
    assert.equal(closed.length, 2)

    // After relief has held, the pool is the machine's own again.
    now += WARM_RELIEF_MS
    assert.equal(owner.residency().warmLimit, 4)
    console.log("pool: four warm on 36 GB, two under memory pressure at the reading, the asked one kept")
  } finally {
    await owner.stop()
  }
}

/** Jobs as the watch uses them: the one job's run and timing, and its demand, with nothing scheduled. */
function fakeJobs() {
  const jobs: { name: string; everyMs: number; run: () => void | Promise<void>; firstAfterMs?: number; needs: readonly JobDemand[] }[] = []
  const demands: JobDemand[] = []
  const every: HostJobs["every"] = (name, everyMs, run, options = {}) => {
    jobs.push({ name, everyMs, run, ...(options.firstAfterMs !== undefined && { firstAfterMs: options.firstAfterMs }), needs: options.needs ?? [] })
    return () => {}
  }
  const demand: HostJobs["demand"] = (name) => {
    const state = { on: false }
    const made: JobDemand = { name, get on() { return state.on }, set: (next) => { state.on = next }, onChange: () => () => {} }
    demands.push(made)
    return made
  }
  return { jobs, demands, every, demand }
}

// ── The watch: memory is read only while more than the floor are warm, and pressure reaches the conversations.
async function watchReadsWhilePastFloor(): Promise<void> {
  const fake = fakeJobs()
  let now = 9_000_000
  let looks = 0
  let warm = 0
  let pressed = 0
  let reading: MacReading = { cores: 14, memoryBytes: 36 * GB }
  const capacity = new FinCapacity({ read: async () => { looks += 1; return reading }, costs: new FinCostModel(), own: () => undefined, hardware: () => ({ cores: 14, memoryBytes: 36 * GB }), now: () => now })
  const wired = watchWarmProviders({ jobs: fake, capacity, live: () => ({ warmProviders: () => warm, memoryPressed: () => { pressed += 1 } }), now: () => now })
  assert.equal(fake.jobs.length, 1)
  const job = fake.jobs[0]!
  const demand = fake.demands[0]!
  assert.equal(job.name, WARM_WATCH_JOB)
  assert.deepEqual([job.everyMs, job.firstAfterMs], [WARM_LOOK_MS, WARM_FIRST_LOOK_MS])
  assert.deepEqual(job.needs, [demand], "the job holds no timer while its demand is off")
  assert.equal(demand.on, false)
  assert.equal(wired.warmLimit(), 3)
  wired.warmKept(2)
  assert.equal(demand.on, false, "at the floor nothing reads the machine")
  wired.warmKept(3)
  assert.equal(demand.on, true, "a third warm provider has memory read")
  warm = 3
  await job.run()
  assert.equal(looks, 1)
  assert.equal(pressed, 0)
  assert.equal(demand.on, true)
  reading = { ...reading, memoryPressure: true }
  now += WARM_LOOK_MS
  await job.run()
  assert.equal(pressed, 1, "its reading of pressure reaches the conversations in the same run")
  assert.equal(wired.warmLimit(), WARM_FLOOR)
  warm = 2
  now += WARM_LOOK_MS
  await job.run()
  assert.equal(demand.on, false, "back at the floor, the job stops reading")
  assert.equal(looks, 3)
  console.log("watch: reads memory only past the floor, and says pressure at the reading")
}

// ── A Mac that has never swapped isn't out of swap: read as pressure, that held every such machine at the floor.
function unallocatedSwapIsNotPressure(): void {
  assert.equal(swapFreeOf("total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)"), undefined, "no swap file made yet says nothing of free swap")
  assert.equal(swapFreeOf("total = 5120.00M  used = 4208.94M  free = 911.06M  (encrypted)"), 911.06 * 1024 ** 2)
  assert.equal(swapFreeOf("total = 2.00G  used = 1.90G  free = 100.00M"), 100 * 1024 ** 2, "a swap file nearly full is still read")
  assert.equal(swapFreeOf("total = 1024.00M  used = 1024.00M  free = 0.00M"), 0, "and one that's full reads as none free")
  assert.equal(swapFreeOf(""), undefined)
}

// ── The host's wiring, on a 36 GB Mac's readings: three stay warm through its looks, a fourth lets the oldest go, a
// look that fails changes nothing, and pressure lets the excess go at the reading.
async function threeStayWarmOnAHost(): Promise<void> {
  const folder = mkdtempSync(join(root, "host-"))
  const closed: string[] = []
  const fake = fakeJobs()
  let now = 3_000_000
  // What `MacCapacity` reads of a Mac with no swap file made, now that it says nothing of swap there.
  const calm: MacReading = { cores: 14, memoryBytes: 36 * GB, busyCores: 3, memoryPressure: false, diskFreeBytes: 100 * GB }
  let read: () => Promise<MacReading> = async () => calm
  const capacity = new FinCapacity({ read: () => read(), costs: new FinCostModel(), own: () => undefined, hardware: () => ({ cores: 14, memoryBytes: 36 * GB }), now: () => now })
  let owner: LiveConversations | undefined
  const wired = watchWarmProviders({ jobs: fake, capacity, live: () => owner, now: () => now })
  const live = new LiveConversations({
    ...wired,
    appPath: folder, root: join(folder, "journals"), driver: () => driver, history: async () => null, emit: () => {},
    providerIdleMs: 60 * 60_000, now: () => now,
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  })
  const driver = restingDriver(() => live, folder, closed, [])
  owner = live
  const job = fake.jobs[0]!
  const demand = fake.demands[0]!
  const ids = Array.from({ length: 4 }, () => randomUUID())
  const connection = (id: string) => live.snapshot(id)?.session.connection
  try {
    for (const id of ids.slice(0, 3)) {
      await seeded(live, folder, id)
      now += 1_000
    }
    await pause(50)
    assert.deepEqual(closed, [], "the third idle provider is kept, before any look at the machine")
    assert.equal(live.residency().warmLimit, 3)
    assert.equal(demand.on, true, "and has the machine's memory read from now on")
    await job.run()
    now += WARM_LOOK_MS
    await job.run()
    await pause(30)
    assert.deepEqual(closed, [], "calm looks leave all three warm")
    assert.equal(live.warmProviders(), 3)

    await seeded(live, folder, ids[3]!)
    await until("the fourth to push the oldest out", () => connection(ids[0]!) === "hibernated")
    assert.deepEqual(closed, [ids[0]])

    // A look that fails says nothing: the number stays the machine's own.
    read = async () => { throw new Error("sysctl failed") }
    now += WARM_LOOK_MS
    await job.run()
    await pause(30)
    assert.equal(closed.length, 1)
    assert.equal(live.residency().warmLimit, 3)

    // Swap nearly gone on a Mac that has a swap file: the excess goes at this reading.
    read = async () => ({ ...calm, swapFreeBytes: 50 * 1024 ** 2 })
    now += WARM_LOOK_MS
    await job.run()
    await until("the excess to hibernate", () => connection(ids[1]!) === "hibernated")
    assert.deepEqual(closed, [ids[0], ids[1]])
    assert.equal(live.residency().warmLimit, WARM_FLOOR)
    assert.equal(connection(ids[2]!), "connected")
    assert.equal(connection(ids[3]!), "connected")
    console.log("host: three warm on a 36 GB Mac through its looks, the fourth lets the oldest go, pressure sheds at the reading")
  } finally {
    await live.stop()
  }
}

// ── A wake inside the idle window starts with what the launch read; past it, or in another title, it reads again.
async function wakeReusesLaunchValues(): Promise<void> {
  const folder = mkdtempSync(join(root, "kept-"))
  const closed: string[] = []
  const starts: { id: string; resume?: string; environment?: ThreadEnvironment }[] = []
  const reads: { title?: string; cwd?: string }[] = []
  const grants: string[] = []
  let verdicts = 0
  let now = 7_000_000
  const idleMs = 10 * 60_000
  const id = randomUUID()
  let owner: LiveConversations
  const driver = restingDriver(() => owner, folder, closed, starts)
  owner = new LiveConversations({
    appPath: folder, root: join(folder, "journals"), driver: () => driver, history: async () => null, emit: () => {},
    providerIdleMs: idleMs, providerWarmLimit: 8, now: () => now,
    tools: (binding) => {
      grants.push(binding)
      return undefined
    },
    threadEnvironment: async (_conversation, title, cwd) => {
      reads.push({ ...(title !== undefined && { title }), ...(cwd !== undefined && { cwd }) })
      return { app: AppKeySchema.parse(id), host: "kept.localhost", port: 4000 + reads.length, ports: 10, dataDir: join(folder, "data") }
    },
    resumeVerdict: async () => {
      verdicts += 1
      return { kind: "resumable", record: "same" }
    },
  })
  const connection = () => owner.snapshot(id)?.session.connection
  const asleep = async () => {
    assert.equal(owner.hibernateIfIdle(id), true)
    await until("it to hibernate", () => connection() === "hibernated")
  }
  const awake = async () => {
    assert.equal(owner.prewarm(id), "waking")
    await until("it to wake", () => connection() === "connected")
  }
  try {
    await seeded(owner, folder, id)
    assert.equal(reads.length, 1, "the launch reads the Thread's values")
    const launched = starts[0]!.environment
    assert.equal(launched?.port, 4001)

    // Closed 30 s into its idle window, as the pool's limit closes one: the wake starts with the launch's values.
    now += 30_000
    await asleep()
    now += 30_000
    await awake()
    assert.equal(reads.length, 1, "a wake inside the idle window reads nothing again")
    assert.equal(starts.length, 2)
    assert.equal(starts[1]!.resume, id, "it resumes the same native session")
    assert.equal(starts[1]!.environment, launched, "with the very values its launch read")
    assert.equal(verdicts, 1, "the resume verdict is still asked: another host may have taken the session meanwhile")
    assert.equal(grants.length, 2, "and its tools are granted again: hibernation revoked the launch's")

    // Woken again inside the next window, it still starts with them: a process never closed would have them too.
    now += 60_000
    await asleep()
    now += 8 * 60_000
    await awake()
    assert.equal(reads.length, 1)
    assert.equal(starts[2]!.environment, launched)

    // Past the window the old process would have ended, and its successor reads again.
    now += 1_000
    await asleep()
    now += idleMs
    await awake()
    assert.equal(reads.length, 2, "a wake past the idle window reads the Thread's values again")
    assert.equal(starts[3]!.environment?.port, 4002)
    assert.equal(verdicts, 3)

    // A new title is something the values are read for: the next wake reads, whenever it comes.
    now += 1_000
    const session = owner.snapshot(id)!.session
    owner.observe({ type: "live-session", session: { ...session, title: "Renamed" } })
    assert.equal(owner.snapshot(id)?.session.title, "Renamed")
    await asleep()
    now += 1_000
    await awake()
    assert.equal(reads.length, 3, "a changed title reads again")
    assert.deepEqual(reads[2], { title: "Renamed", cwd: folder })
    console.log(`kept: ${starts.length} starts read the Thread's values ${reads.length} times; the resume verdict ${verdicts} times and the tools ${grants.length} times, at every wake`)
  } finally {
    await owner.stop()
  }
}

// ── A held credential read kept standing while a conversation is warm, by a check that never reads the secret again.
async function heldReadsStayFresh(): Promise<void> {
  let now = 1_000
  const revisions = new CredentialRevisions(CREDENTIAL_HOLD_MS, () => now)
  let reads = 0
  let checks = 0
  let stored = "signed-in"
  let stands: () => Promise<boolean> = async () => true
  const read = async () => {
    reads += 1
    return stored
  }
  const readAts: number[] = []
  const ask = () => revisions.holder("claude")("keychain", read, (_value, readAt) => {
    checks += 1
    readAts.push(readAt)
    return stands()
  })
  const warm = new Set(["claude"])
  assert.equal(await ask(), "signed-in")
  assert.equal(reads, 1)
  now += CREDENTIAL_REFRESH_MS
  assert.equal(revisions.refresh(new Set(["devin"])), 0, "another harness's warm conversation checks nothing of this one's")
  assert.equal(revisions.refresh(warm), 1)
  await pause(0)
  assert.deepEqual([reads, checks, readAts[0]], [1, 1, 1_000], "the store is asked whether it still stands as read; the secret isn't read again")
  now += CREDENTIAL_REFRESH_MS
  assert.equal(await ask(), "signed-in")
  assert.equal(reads, 1, "five seconds after the read, a send finds it standing from the check and reads nothing")

  // What a send takes is never older than the hold: with no check since, the ask reads for itself.
  now += CREDENTIAL_HOLD_MS
  assert.equal(await ask(), "signed-in")
  assert.equal(reads, 2)

  // The store changed outside Mako: the check says so, the read is left to age out, and nothing checks it again.
  stored = "signed-out"
  stands = async () => false
  now += CREDENTIAL_REFRESH_MS
  assert.equal(revisions.refresh(warm), 1)
  await pause(0)
  assert.equal(revisions.refresh(warm), 0, "a read its store no longer vouches for isn't checked again")
  assert.equal(await ask(), "signed-in", "inside the hold the read still answers, as it would have with no check at all")
  now += CREDENTIAL_HOLD_MS
  assert.equal(await ask(), "signed-out", "and past it the send reads the change for itself")
  assert.equal(reads, 3)

  // A check that fails (a locked keychain, a `security` that won't run) is never begun again: no loop of asking.
  stands = async () => { throw new Error("security failed") }
  now += CREDENTIAL_REFRESH_MS
  const before = checks
  assert.equal(revisions.refresh(warm), 1)
  await pause(0)
  for (let tick = 0; tick < 5; tick++) {
    now += CREDENTIAL_REFRESH_MS
    assert.equal(revisions.refresh(warm), 0)
  }
  await pause(0)
  assert.equal(checks, before + 1, "one failed check, and none after it")
  assert.equal(await ask(), "signed-out")
  assert.equal(reads, 4, "the next send reads for itself, as every send did")

  // A check that hasn't answered (one waiting on the person) has no second begun beside it.
  let answer = (_current: boolean) => {}
  stands = () => new Promise<boolean>((resolve) => { answer = resolve })
  now += CREDENTIAL_HOLD_MS
  assert.equal(await ask(), "signed-out")
  const hanging = checks
  for (let tick = 0; tick < 4; tick++) {
    now += CREDENTIAL_REFRESH_MS
    assert.equal(revisions.refresh(warm), 1, "it still counts as being checked")
    await pause(0)
  }
  assert.equal(checks, hanging + 1, "four ticks, one check")
  answer(true)
  await pause(0)

  // A check that spans an account change made in Mako vouches for nothing.
  stands = () => new Promise<boolean>((resolve) => { answer = resolve })
  now += CREDENTIAL_HOLD_MS
  assert.equal(await ask(), "signed-out")
  now += CREDENTIAL_REFRESH_MS
  revisions.refresh(warm)
  await pause(0)
  revisions.forget("claude")
  stored = "another account"
  answer(true)
  await pause(0)
  assert.equal(await ask(), "another account", "a read from before the change never answers an ask after it")

  // Left unasked past the bound, nothing is checked for it.
  stands = async () => true
  const settled = checks
  now += CREDENTIAL_REFRESH_FOR_MS
  assert.equal(revisions.refresh(warm), 0, "a sign-in nothing has asked about for two minutes isn't checked")
  await pause(0)
  assert.equal(checks, settled)

  // A read whose adapter can't say whether its store stands is never checked, and only ages.
  assert.equal(await revisions.holder("codex")("plain", async () => "x"), "x")
  assert.equal(revisions.refresh(new Set(["codex"])), 0)

  // The Keychain's own answer, on a Mac, for an item that isn't there: attributes alone, and nothing of anyone's.
  if (process.platform === "darwin") {
    const absent = `mako-warm-wakes-absent-${randomUUID()}`
    assert.equal(await keychainUnchangedSince(absent, "nobody", false, Date.now()), true, "an item read as missing still stands while it's missing")
    assert.equal(await keychainUnchangedSince(absent, "nobody", true, Date.now()), false, "one read as there doesn't once it's gone")
  }

  // The job: on while a provider rests warm and something is held for its harness, off otherwise.
  const fake = fakeJobs()
  const asked: string[][] = []
  let held = 1
  let harnesses = new Set(["claude"])
  const wired = keepAccountsFresh({ jobs: fake, accounts: { refreshCredentials: (providers) => { asked.push([...providers]); return held } }, live: () => ({ warmHarnesses: () => harnesses }) })
  const job = fake.jobs[0]!
  const demand = fake.demands[0]!
  assert.deepEqual([job.name, job.everyMs, job.firstAfterMs], [ACCOUNT_WATCH_JOB, CREDENTIAL_REFRESH_MS, 0])
  assert.ok(CREDENTIAL_REFRESH_MS * 1.1 + 200 < CREDENTIAL_HOLD_MS, "a check lands inside the hold, the job's drift and the check's own time counted")
  assert.equal(demand.on, false, "with nothing warm the job holds no timer")
  wired.cameToRest()
  assert.equal(demand.on, true)
  await job.run()
  assert.deepEqual(asked, [["claude"]])
  assert.equal(demand.on, true)
  held = 0
  await job.run()
  assert.equal(demand.on, false, "a harness that holds no read is asked once and left alone")
  wired.cameToRest()
  held = 1
  harnesses = new Set()
  await job.run()
  assert.equal(demand.on, false, "and nothing is read once no provider is warm")
  assert.equal(asked.length, 2)
  console.log("accounts: a warm conversation's held read stands while its store vouches for it, by a check that never reads the secret; a failed or hanging check isn't repeated")
}

// ── A draft begun in a warm conversation has its account check begun, so a send soon after finds the read done.
async function prewarmBeginsTheAccountCheck(): Promise<void> {
  const folder = mkdtempSync(join(root, "ahead-"))
  const ahead: string[] = []
  let owner: LiveConversations
  const driver: AdmittedLiveDriver = { ...restingDriver(() => owner, folder, [], []), admitAhead: (id) => { ahead.push(id) } }
  owner = new LiveConversations({
    appPath: folder, root: join(folder, "journals"), driver: () => driver, history: async () => null, emit: () => {},
    providerIdleMs: 60 * 60_000, providerWarmLimit: 8,
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  })
  const id = randomUUID()
  try {
    await seeded(owner, folder, id)
    const sends = ahead.length
    assert.equal(owner.prewarm(id), "kept-warm")
    assert.deepEqual(ahead.slice(sends), [id], "typing into a warm conversation begins its account check, once a signal")
    assert.equal(owner.expect(id), "kept-warm")
    assert.equal(ahead.length, sends + 2, "as does an agent's message on its way to one")
    assert.equal(owner.snapshot(id)?.requests.length, 1, "and neither sends anything")
    assert.equal(owner.hibernateIfIdle(id), true)
    await until("it to hibernate", () => owner.snapshot(id)?.session.connection === "hibernated")
    const asleep = ahead.length
    assert.equal(owner.prewarm(id), "waking")
    await until("it to wake", () => owner.snapshot(id)?.session.connection === "connected")
    assert.equal(ahead.length, asleep, "a sleeping one is woken instead: its launch reads the account itself")
    console.log("ahead: a prewarm of a warm conversation begins its account check; a wake leaves that to the launch")
  } finally {
    await owner.stop()
  }
}

// ── What `expect` leaves alone: a digest that's paused or held past its window, and one it knows nothing of.
async function expectRefusesWhatWontGo(): Promise<void> {
  const folder = mkdtempSync(join(root, "expect-"))
  const starts: { id: string; resume?: string }[] = []
  let owner: LiveConversations
  const driver = restingDriver(() => owner, folder, [], starts)
  owner = new LiveConversations({
    appPath: folder, root: join(folder, "journals"), driver: () => driver, history: async () => null, emit: () => {},
    providerIdleMs: 60 * 60_000, providerWarmLimit: 8,
    resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  })
  const sleeping = async () => {
    const id = randomUUID()
    await seeded(owner, folder, id)
    assert.equal(owner.hibernateIfIdle(id), true)
    await until("it to hibernate", () => owner.snapshot(id)?.session.connection === "hibernated")
    return id
  }
  const digest = { notices: [] }
  try {
    const paused = await sleeping()
    const first = randomUUID()
    owner.submit(paused, first, "news", [], undefined, undefined, undefined, undefined, { digest, pause: "stop" })
    assert.equal(owner.expect(paused, first), "unchanged", "a digest paused for a stopped Fin wakes nothing")

    const later = await sleeping()
    const second = randomUUID()
    owner.submit(later, second, "news", [], undefined, undefined, undefined, undefined, { digest, wake: { at: Date.now() + 60_000, after: DIGEST_WAITS } })
    assert.equal(owner.expect(later, second), "unchanged", "a digest held past its burst's window wakes nothing")
    assert.equal(owner.expect(later, randomUUID()), "unchanged", "nor does a request the conversation never took")

    const scheduled = await sleeping()
    const third = randomUUID()
    owner.submit(scheduled, third, "at three", [], undefined, undefined, undefined, undefined, { wake: { at: Date.now() + 60_000, after: randomUUID() } })
    assert.equal(owner.expect(scheduled, third), "unchanged", "a message the person scheduled isn't a digest's window")

    const archived = await sleeping()
    owner.setArchived(archived, true)
    assert.equal(owner.expect(archived), "unchanged", "an archived conversation is never woken, as prewarm refuses it")

    assert.equal(owner.expect(randomUUID()), "unchanged", "an unknown conversation is left alone")
    await pause(50)
    assert.equal(starts.filter((start) => start.resume).length, 0, "none of them started a process")

    const windowed = await sleeping()
    const fourth = randomUUID()
    owner.submit(windowed, fourth, "news", [], undefined, undefined, undefined, undefined, { digest, wake: { at: Date.now() + WAKE_COALESCE_MS, after: DIGEST_WAITS } })
    assert.equal(owner.expect(windowed, fourth), "waking", "a digest inside its window wakes its conversation now")
    await until("it to wake", () => owner.snapshot(windowed)?.session.connection === "connected")
    assert.equal(owner.snapshot(windowed)?.requests.find((asked) => asked.id === fourth)?.status, "held", "and sends nothing before its time")
    assert.equal(owner.expect(windowed, fourth), "kept-warm", "once warm, the same word only restarts its idle window")

    // The minute's budget: an Apex that took six digests in the last minute holds the seventh past its window, so
    // nothing wakes for it early. One that took five still wakes.
    const took = async (count: number) => {
      const id = randomUUID()
      await seeded(owner, folder, id)
      for (let sent = 0; sent < count; sent++) {
        const request = randomUUID()
        owner.submit(id, request, `news ${sent}`, [], undefined, undefined, undefined, undefined, { digest })
        await until("a digest's turn", () => owner.snapshot(id)?.requests.some((asked) => asked.id === request && asked.status === "completed") === true)
      }
      assert.equal(owner.snapshot(id)!.requests.filter((asked) => asked.digest?.sentAt !== undefined).length, count, "each digest is stamped as it's sent")
      await until("it to come to rest", () => owner.hibernateIfIdle(id) || owner.snapshot(id)?.session.connection === "hibernated")
      await until("it to hibernate", () => owner.snapshot(id)?.session.connection === "hibernated")
      const next = randomUUID()
      owner.submit(id, next, "more news", [], undefined, undefined, undefined, undefined, { digest, wake: { at: Date.now() + WAKE_COALESCE_MS, after: DIGEST_WAITS } })
      return owner.expect(id, next)
    }
    const resumed = () => starts.filter((start) => start.resume).length
    const beforeBudget = resumed()
    assert.equal(await took(WAKES_PER_MINUTE), "unchanged", "over the minute's budget, a digest wakes nothing early")
    await pause(50)
    assert.equal(resumed(), beforeBudget, "and no process started for it")
    assert.equal(await took(WAKES_PER_MINUTE - 1), "waking", "one under the budget wakes its conversation")
    console.log("expect: wakes for a digest in its window; none for one paused, held for later, scheduled, archived, unknown or over the minute's budget")
  } finally {
    await owner.stop()
  }
}

/** A world whose Apex has one Fin at rest, and a record of each `expect` and `submit` the engine makes, in order. */
async function family(options: { providerIdleMs?: number } = {}) {
  const gate = { open: () => {} }
  const script: Script = async (turn) => {
    if (turn.text.includes("Take your time")) await new Promise<void>((resolve) => { gate.open = resolve })
    return turn.text.includes("You're fin:") ? "Labels finished." : "ok"
  }
  const w = new AgentsWorld({ root: mkdtempSync(join(root, "world-")), script, ...(options.providerIdleMs !== undefined && { providerIdleMs: options.providerIdleMs }) })
  const apex = await w.apex("claude", "full")
  const started = await w.agents.start(apex.caller, { brief: { objective: "Label everything" }, name: "labels", harness: "claude", cwd: w.root, clientKey: "labels" })
  assert.ok(!("refused" in started), JSON.stringify(started))
  await until("its first turn", () => w.prompts.some((prompt) => prompt.text.includes("You're fin:")))
  await w.settle(40, 20_000)
  const fin = w.store.thread(ThreadIdSchema.parse(started.child!))!.sessions.flatMap((session) => w.store.conversationsOf(session))[0]!
  const calls: { what: "expect" | "submit"; conversation: string; request?: string; said?: string; at: number }[] = []
  const expect = w.live.expect.bind(w.live)
  const submit = w.live.submit.bind(w.live)
  w.live.expect = (id, request) => {
    const said = expect(id, request)
    calls.push({ what: "expect", conversation: id, ...(request !== undefined && { request }), said, at: Date.now() })
    return said
  }
  w.live.submit = (...args) => {
    calls.push({ what: "submit", conversation: args[0], request: args[1], at: Date.now() })
    return submit(...args)
  }
  const connection = (conversation: string) => w.live.snapshot(conversation)?.session.connection
  const sleep = async (conversation: string) => {
    await until("it to come to rest", () => w.live.hibernateIfIdle(conversation) || connection(conversation) === "hibernated")
    await until("it to hibernate", () => connection(conversation) === "hibernated")
  }
  const resumes = (conversation: string) => w.starts.filter((start) => start.conversation === conversation && start.resume).length
  return { w, apex, fin, calls, connection, sleep, resumes, gate }
}

// ── `agents_send` to a sleeping Fin starts its wake before the message is admitted; a refused one wakes nothing.
async function sendWakesASleepingFin(): Promise<void> {
  const f = await family()
  const { w } = f
  await f.sleep(f.fin)
  const sent = await w.agents.send(f.apex.caller, { to: "labels", text: "One more label", clientKey: randomUUID(), reply: "none" })
  assert.ok(!("refused" in sent), JSON.stringify(sent))
  const mine = f.calls.filter((call) => call.conversation === f.fin)
  assert.deepEqual(mine.map((call) => call.what), ["expect", "submit"], "the wake starts before the message is admitted")
  assert.equal(mine[0]!.said, "waking")
  // The wake is the message's own way in, never work ahead of it: the send answers as a turn starting, as it did
  // before any early wake, and the message is the first thing the woken Fin hears.
  assert.equal(sent.delivery, "turn", `a message to a Fin at rest starts its turn: ${sent.hears}`)
  assert.doesNotMatch(sent.hears, /current turn ends|hasn't started/)
  await until("the Fin to take it", () => w.prompts.some((prompt) => prompt.conversation === f.fin && prompt.text.includes("One more label")))
  assert.equal(f.resumes(f.fin), 1, "the early wake and the message share one launch")
  const since = w.prompts.filter((prompt) => prompt.conversation === f.fin).slice(1)
  assert.ok(since[0]!.text.includes("One more label"), "and the message goes first to the woken Fin")
  await w.settle()

  // Archived, the Fin's message is refused: nothing wakes for it.
  await f.sleep(f.fin)
  f.calls.length = 0
  w.archived.add(f.fin)
  const refused = await w.agents.send(f.apex.caller, { to: "labels", text: "And another", clientKey: randomUUID() })
  assert.ok("refused" in refused, "an archived Fin takes no message")
  await pause(50)
  assert.deepEqual(f.calls.filter((call) => call.conversation === f.fin), [], "a refused message neither expects nor submits")
  assert.equal(f.connection(f.fin), "hibernated")
  assert.equal(f.resumes(f.fin), 1, "and starts no process")
  w.archived.delete(f.fin)

  // At work, the Fin has a provider running: a message queued behind its turn expects nothing.
  const busy = await w.agents.send(f.apex.caller, { to: "labels", text: "Take your time", clientKey: randomUUID(), reply: "none" })
  assert.ok(!("refused" in busy), JSON.stringify(busy))
  await until("the Fin to be at work", () => w.prompts.some((prompt) => prompt.conversation === f.fin && prompt.text.includes("Take your time")))
  f.calls.length = 0
  const behind = await w.agents.send(f.apex.caller, { to: "labels", text: "Then this", clientKey: randomUUID(), reply: "none" })
  assert.ok(!("refused" in behind), JSON.stringify(behind))
  assert.deepEqual(f.calls.filter((call) => call.conversation === f.fin).map((call) => call.what), ["submit"], "a Fin at work is sent to, not woken")
  f.gate.open()
  await until("the Fin to take what waited", () => w.prompts.some((prompt) => prompt.conversation === f.fin && prompt.text.includes("Then this")))
  await w.settle()
  console.log("send: a sleeping Fin wakes before its message is admitted, on one resume; an archived or working one isn't woken")
  await w.close()
}

// ── A Stop that crosses an `agents_send` after its early wake began: the message is held as the Stop decides, the wake
// sends nothing, and the provider it started retires on its idle window.
async function stopCrossesAnEarlyWake(): Promise<void> {
  const idleMs = 400
  const f = await family({ providerIdleMs: idleMs })
  const { w } = f
  await f.sleep(f.fin)
  f.calls.length = 0
  const before = w.prompts.length
  // The send runs to its first wait, which is past the early wake; the Stop then reaches it before it is admitted.
  const sending = w.agents.send(f.apex.caller, { to: "labels", text: "One last label", clientKey: randomUUID(), reply: "none" })
  const woke = f.calls.filter((call) => call.conversation === f.fin)
  assert.deepEqual(woke.map((call) => [call.what, call.said]), [["expect", "waking"]], "the early wake began before the Stop arrived")
  const stopping = w.agents.stop(f.apex.caller, { child: "labels", reason: "pausing" })
  const [sent, stopped] = await Promise.all([sending, stopping])
  assert.ok(!("refused" in stopped), JSON.stringify(stopped))
  assert.ok(!("refused" in sent), JSON.stringify(sent))
  assert.equal(sent.delivery, "queued")
  assert.match(sent.hears, /was stopped as this reached it: it waits, held/)
  const held = w.live.snapshot(f.fin)!.requests.find((request) => request.text.includes("One last label"))!
  assert.deepEqual([held.status, held.pause], ["held", "stop"], "the message waits under the Stop, as any message does")
  await until("the early wake to end", () => f.connection(f.fin) === "connected" || f.resumes(f.fin) === 1 && f.connection(f.fin) === "hibernated")
  assert.equal(f.resumes(f.fin), 1, "the wake that had begun ran once")
  await until("the woken provider to retire on its idle window", () => f.connection(f.fin) === "hibernated", idleMs * 20)
  assert.equal(w.prompts.slice(before).filter((prompt) => prompt.conversation === f.fin).length, 0, "nothing was sent to the stopped Fin: the wake sends nothing and the Stop holds the message")
  assert.equal(w.live.snapshot(f.fin)!.requests.find((request) => request.id === held.id)?.status, "held")
  assert.equal(f.resumes(f.fin), 1, "and nothing woke it again")
  console.log("stop: a Stop crossing a send after its early wake holds the message; the woken provider sent nothing and retired on its idle window")
  await w.close()
}

// ── A lone report wakes a sleeping Apex and goes at once; the next, within its window after that one went, is held
// for the rest of the window and wakes the Apex through it, going when the window ends.
async function digestWakesASleepingApex(): Promise<void> {
  const f = await family()
  const { w } = f
  const apex = f.apex.conversation
  const digestsSince = (before: number) => w.prompts.slice(before).filter((prompt) => prompt.conversation === apex)
  await f.sleep(apex)
  // Past the window after the digest its Fin's first turn sent, so the next report is a lone one.
  await pause(WAKE_COALESCE_MS + 100)
  f.calls.length = 0
  let before = w.prompts.length
  // The Fin works again and reports: its Apex, idle and asleep, is owed a digest, and hears it at once.
  const sent = await w.agents.send(f.apex.caller, { to: "labels", text: "Label the rest", clientKey: randomUUID() })
  assert.ok(!("refused" in sent), JSON.stringify(sent))
  await until("the first digest to go", () => digestsSince(before).length > 0)
  const lone = f.calls.find((call) => call.what === "submit" && call.conversation === apex)!
  const first = digestsSince(before)[0]!
  assert.ok(!f.calls.some((call) => call.what === "expect" && call.conversation === apex), "a lone report is held for no window to wake through")
  assert.ok(first.at - lone.at < 1_000, `a lone report goes at once (${first.at - lone.at} ms)`)
  assert.equal(f.resumes(apex), 1, "its own submit woke the Apex")
  // Right after it, asleep again: the next report is held until the window after the first went, and wakes it through it.
  await w.settle(40, 20_000)
  await f.sleep(apex)
  f.calls.length = 0
  before = w.prompts.length
  const again = await w.agents.send(f.apex.caller, { to: "labels", text: "Label the rest again", clientKey: randomUUID() })
  assert.ok(!("refused" in again), JSON.stringify(again))
  await until("the digest to be queued", () => f.calls.some((call) => call.what === "submit" && call.conversation === apex))
  const expected = f.calls.find((call) => call.what === "expect" && call.conversation === apex)
  const admitted = f.calls.find((call) => call.what === "submit" && call.conversation === apex)!
  assert.ok(expected, `the next digest, ${admitted.at - first.at} ms after the first went, is held for its window and wakes the Apex through it`)
  assert.equal(expected.request, admitted.request, "the wake is for the digest just queued")
  assert.ok(f.calls.indexOf(admitted) < f.calls.indexOf(expected), "and starts once the queue has taken it")
  assert.equal(expected.said, "waking")
  await until("the Apex to wake", () => f.connection(apex) === "connected")
  const wokeAt = Date.now()
  await until("the digest to go", () => digestsSince(before).length > 0)
  const digest = digestsSince(before)[0]!
  assert.ok(digest.at - first.at >= WAKE_COALESCE_MS - 100, `the digest waits out its window after the last one went (${digest.at - first.at} ms)`)
  assert.ok(wokeAt <= digest.at, `the provider was up ${digest.at - wokeAt} ms before the digest went`)
  assert.equal(f.resumes(apex), 2, "one resume serves the early wake and the digest")
  await w.settle()
  console.log(`digest: a lone report went ${first.at - lone.at} ms after it was queued; the next waited ${digest.at - first.at} ms after it, its Apex up ${digest.at - wokeAt} ms before it went`)
  await w.close()
}

try {
  ruleTable()
  await capacityReads()
  unallocatedSwapIsNotPressure()
  await threeStayWarmOnAHost()
  await watchReadsWhilePastFloor()
  await pressureShrinksThePool()
  await wakeReusesLaunchValues()
  await heldReadsStayFresh()
  await prewarmBeginsTheAccountCheck()
  await expectRefusesWhatWontGo()
  await sendWakesASleepingFin()
  await stopCrossesAnEarlyWake()
  await digestWakesASleepingApex()
  console.log("warm wakes: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
