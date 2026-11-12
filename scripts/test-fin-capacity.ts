import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { join } from "node:path"
import { CapacityGovernor, cloudCapacity, deviceCapacity, PRIOR_COST, DEVICE_CEILING } from "@mako/host/conversations/fin-capacity"
import { FinCapacity, pressureOf } from "@mako/host/conversations/fin-capacity-host"
import { FinCostModel } from "@mako/host/conversations/fin-cost"
import { FinCostSampler } from "@mako/host/conversations/fin-cost-sampler"
import type { ProcessRow } from "@mako/host/usage/mako-footprint"
import { MacCapacity, type MacReading } from "@mako/host/conversations/mac-capacity"

/**
 * A Fin's capacity (`npm run test:fin-capacity`): each machine's number from its hardware and what a Fin costs there,
 * the governor that lowers it only under sustained pressure, the cost each machine learns of its own Fins, the cloud's
 * sandboxes, and the device's number as the person's own one replaces it. Fake hardware, readings and clock only.
 */
const GB = 1024 ** 3

// ── Each machine's number, from its hardware and a Fin's cost.
{
  const mac = deviceCapacity({ cores: 14, memoryBytes: 36 * GB })
  assert.equal(mac.atOnce, 17, "the person's 14-core, 36 GB Mac lands where they expect, between 10 and 20")
  assert.equal(mac.builds, 1)
  assert.equal(mac.why, "14 cores, 36 GB · a Fin ≈ 0.35 core, 0.8 GB · room for 1 build")
  assert.equal(deviceCapacity({ cores: 8, memoryBytes: 16 * GB }).atOnce, 8, "a MacBook Air takes fewer")
  assert.equal(deviceCapacity({ cores: 2, memoryBytes: 8 * GB, headless: true }).atOnce, 2, "a 2 vCPU, 8 GB box takes a couple")
  const big = deviceCapacity({ cores: 64, memoryBytes: 256 * GB, headless: true })
  assert.equal(big.atOnce, DEVICE_CEILING, "a big Linux box takes many, up to the device ceiling")
  assert.equal(big.builds, 4)
  assert.ok(big.cpu > 100)
  assert.equal(deviceCapacity({ cores: 1, memoryBytes: 2 * GB }).atOnce, 1, "a tiny machine still runs one")
  // Memory bounds it when a Fin's memory is what's dear.
  const heavy = deviceCapacity({ cores: 14, memoryBytes: 36 * GB }, { ...PRIOR_COST, memoryBytes: 3 * GB })
  assert.equal(heavy.atOnce, 8)
  assert.ok(heavy.memory < heavy.cpu)
  // A lighter harness on the same Mac takes more.
  assert.equal(deviceCapacity({ cores: 14, memoryBytes: 36 * GB }, { ...PRIOR_COST, cores: 0.25 }).atOnce, 24)
}

// ── The governor: one busy minute moves nothing; sustained pressure lowers it a Fin a minute to a floor; relief brings it back.
{
  const governor = new CapacityGovernor()
  let now = 0
  const tick = (pressed: boolean, minutes: number) => {
    for (let at = 0; at < minutes * 6; at += 1) {
      now += 10_000
      governor.read(now, { memory: pressed })
      governor.allow(now, 17)
    }
  }
  tick(false, 10)
  assert.equal(governor.allow(now, 17).atOnce, 17)
  tick(true, 1)
  tick(false, 5)
  assert.equal(governor.allow(now, 17).atOnce, 17, "one busy minute never squeezes it")
  tick(true, 7)
  assert.equal(governor.allow(now, 17).atOnce, 17, "seven minutes of pressure is still only becoming sustained")
  tick(true, 3)
  const early = governor.allow(now, 17)
  assert.ok(early.atOnce >= 13 && early.atOnce < 17, `sustained pressure lowers it a Fin a minute: ${early.atOnce}`)
  assert.match(early.why ?? "", /^\d+ now, not 17: memory pressure for \d+ min$/)
  tick(true, 60)
  assert.equal(governor.allow(now, 17).atOnce, 9, "never below half")
  tick(false, 4)
  assert.equal(governor.allow(now, 17).atOnce, 9, "relief must hold before it comes back")
  tick(false, 30)
  assert.equal(governor.allow(now, 17).atOnce, 17, "and then it's back")
  assert.equal(governor.allow(now, 17).why, undefined)
  const small = new CapacityGovernor()
  for (let at = 0; at < 600; at += 1) {
    small.read(at * 10_000, { thermal: true })
    small.allow(at * 10_000, 2)
  }
  assert.equal(small.allow(6_000_000, 2).atOnce, 1, "a small machine keeps at least one")
}

// ── Pressure from one reading.
{
  const hardware = { cores: 14, memoryBytes: 36 * GB }
  const reading = (over: Partial<MacReading> = {}): MacReading => ({ cores: 14, memoryBytes: 36 * GB, busyCores: 4, ...over })
  assert.deepEqual(pressureOf(reading(), 2, hardware), { memory: false, thermal: false, person: false, disk: false })
  assert.equal(pressureOf(reading({ busyCores: 13.5 }), 2, hardware).person, true, "the person's own work past their reserve, with no idle core to spare")
  assert.equal(pressureOf(reading({ busyCores: 14 }), 13, hardware).person, false, "cores the Fins were measured to take aren't the person's")
  assert.equal(pressureOf({ cores: 14, memoryBytes: 36 * GB }, 0, hardware).person, false, "no reading of the cores presses nothing")
  // The Mac as it stood on 2026-11-05, measured: 1 Fin at work, 9 cores busy, 5 idle, the load average at 18.
  assert.equal(pressureOf(reading({ busyCores: 9 }), 1, hardware).person, false, "idle cores are room, whatever keeps the rest busy")
  // Fins mostly wait on their models: a full Mac presses however many there are, unless their own processes filled it.
  for (const [each, pressed] of [[0.05, true], [14 / 8, false]] as const) {
    let at = 0
    const fins = Array.from({ length: 8 }, (_, index) => ({ conversation: `fin-${index}`, harness: "claude" }))
    const capacity = new FinCapacity({
      read: async () => reading({ busyCores: 14 }),
      costs: new FinCostModel(),
      sampler: new FinCostSampler({
        table: async () => fins.map((_, index) => ({ pid: 10 + index, ppid: 1, rssKb: 1024, cpuPercent: 0, cpuSeconds: (each * at) / 1000, command: "/opt/claude/claude" })),
        owned: () => fins.map(({ conversation }, index) => ({ pid: 10 + index, owner: conversation })),
        now: () => at,
      }),
      own: () => undefined,
      hardware: () => hardware,
      now: () => at,
    })
    for (; at < 30 * 60_000; at += 10_000) await capacity.observe(8, { claude: 8 }, fins)
    assert.equal(/your own work is busy/.test(capacity.reading().pressure ?? ""), pressed, `8 Fins taking ${each} core each on a full Mac`)
  }
  // A Fin measured filling the Mac has gone, a shell-linked one holds its place, and other work fills the Mac: what the
  // gone one took doesn't excuse it, whether the next look read no Fins at work or could read nothing.
  for (const after of ["gone", "unreadable"] as const) {
    let at = 0
    let gone = false
    const fin = [{ conversation: "fin", harness: "claude" }]
    const capacity = new FinCapacity({
      read: async () => reading({ busyCores: 14 }),
      costs: new FinCostModel(),
      sampler: new FinCostSampler({
        table: async () => {
          if (gone && after === "unreadable") throw new Error("ps failed")
          return [{ pid: 10, ppid: 1, rssKb: 1024, cpuPercent: 0, cpuSeconds: (14 * at) / 1000, command: "/opt/claude/claude" }]
        },
        owned: () => gone ? [] : [{ pid: 10, owner: "fin" }],
        now: () => at,
      }),
      own: () => undefined,
      hardware: () => hardware,
      now: () => at,
    })
    for (; at < 60_000; at += 10_000) await capacity.observe(1, { claude: 1 }, fin)
    assert.equal(capacity.reading().pressure, undefined, "while it fills the Mac, nothing presses")
    gone = true
    for (; at < 31 * 60_000; at += 10_000) await capacity.observe(1, { claude: 1 }, fin)
    assert.match(capacity.reading().pressure ?? "", /your own work is busy/, `the Fin's cores don't outlast it: ${after}`)
  }
  // A look that measures nothing keeps the last reading while it's fresh: a window too short says nothing of the Fins.
  {
    let at = 0
    const fin = [{ conversation: "fin", harness: "claude" }]
    const capacity = new FinCapacity({
      read: async () => reading({ busyCores: 14 }),
      costs: new FinCostModel(),
      sampler: new FinCostSampler({
        table: async () => [{ pid: 10, ppid: 1, rssKb: 1024, cpuPercent: 0, cpuSeconds: (14 * at) / 1000, command: "/opt/claude/claude" }],
        owned: () => [{ pid: 10, owner: "fin" }],
        now: () => at,
      }),
      own: () => undefined,
      hardware: () => hardware,
      now: () => at,
    })
    for (; at < 15 * 60_000; at += 10_000) {
      await capacity.observe(1, { claude: 1 }, fin)
      await capacity.observe(1, { claude: 1 }, fin)
    }
    assert.equal(capacity.reading().pressure, undefined, "a second look at once doesn't forget what the Fin took")
  }
  // What capacity reads over minutes of that Mac: nothing presses, so the number stays the machine's own.
  {
    let at = 0
    const capacity = new FinCapacity({
      read: async () => reading({ busyCores: 9 }),
      costs: new FinCostModel(undefined),
      own: () => undefined,
      hardware: () => hardware,
      now: () => at,
    })
    const base = capacity.atOnce()
    for (; at < 15 * 60_000; at += 10_000) await capacity.observe(1, {})
    assert.equal(capacity.atOnce(), base, "five idle cores cut nothing")
  }
  assert.equal(pressureOf(reading({ memoryPressure: true }), 0, hardware).memory, true)
  assert.equal(pressureOf(reading({ swapFreeBytes: 100 * 1024 ** 2 }), 0, hardware).memory, true)
  assert.equal(pressureOf(reading({ hot: true }), 0, hardware).thermal, true)
  assert.equal(pressureOf(reading({ diskFreeBytes: 5 * GB }), 0, hardware).disk, true)
}

// ── A reading is the CPU time really spent since the last one: what isn't busy is idle, whatever the load average says.
{
  let at = 0
  let ticks = { busy: 0, total: 0 }
  const mac = new MacCapacity({ now: () => at, ticks: () => ticks })
  const cores = availableParallelism()
  const spend = (busyShare: number) => {
    at += 10_000
    ticks = { busy: ticks.busy + busyShare * 10_000 * cores, total: ticks.total + 10_000 * cores }
  }
  spend(0.25)
  assert.equal((await mac.read()).busyCores, cores * 0.25)
  spend(0.75)
  assert.equal((await mac.read()).busyCores, cores * 0.75, "each reading covers only the time since the last")
  at += 1_000
  ticks = { busy: ticks.busy + 1_000 * cores, total: ticks.total + 1_000 * cores }
  assert.equal((await mac.read()).busyCores, cores * 0.75, "a burst of starts reads the Mac once")
  // Reads side by side: the first takes the CPU time spent, and the next would find none and call a full Mac idle.
  spend(1)
  assert.deepEqual((await Promise.all([mac.read(), mac.read(), mac.read()])).map((reading) => reading.busyCores), [cores, cores, cores], "they share one reading")
  assert.equal((await mac.read()).busyCores, cores, "and it stays what's kept")
  // Time passed, but no CPU time did: that says nothing of the cores, whichever reading came before.
  at += 10_000
  assert.equal((await mac.read()).busyCores, cores, "no time spent keeps the last reading")
  assert.equal((await new MacCapacity({ now: () => at, ticks: () => ticks }).read()).busyCores, undefined, "and a first reading says nothing")
}

// ── The cost each machine learns of its own Fins, per harness, kept across hosts.
{
  const folder = mkdtempSync(join(tmpdir(), "mako-fin-cost-"))
  try {
    const file = join(folder, "fin-cost.json")
    const costs = new FinCostModel(file)
    assert.deepEqual(costs.cost(), PRIOR_COST, "a machine that read nothing is on the prior")
    assert.equal(costs.measured(), false)
    // A light harness: about 0.1 core and 300 MB, 1 in 4 readings a little more; its builds take 3 cores and 1.5 GB.
    for (let at = 0; at < 4_000; at += 1) {
      const busy = at % 4 === 0
      costs.add({ harness: "codex", cores: busy ? 0.3 : 0.1, memoryBytes: (busy ? 0.45 : 0.3) * GB })
      if (at % 10 === 0) costs.add({ harness: "codex", cores: 3, memoryBytes: 1.5 * GB, build: true })
    }
    const codex = costs.of("codex")
    assert.ok(codex.cores >= 0.1 && codex.cores <= 0.3, `light cores near the 75th percentile: ${codex.cores}`)
    assert.ok(codex.memoryBytes >= 0.3 * GB && codex.memoryBytes <= 0.45 * GB, `memory near the 75th percentile: ${codex.memoryBytes / GB}`)
    assert.ok(Math.abs(codex.buildCores - 3) < 0.5, `a build's cores: ${codex.buildCores}`)
    assert.equal(costs.measured(), true)
    assert.deepEqual(costs.of("claude"), PRIOR_COST, "a harness it never read is the prior")
    const mixed = costs.cost({ codex: 1, claude: 1 })
    assert.ok(mixed.cores > codex.cores && mixed.cores < PRIOR_COST.cores, "the mix of Fins at work weighs each harness")
    costs.add({ harness: "codex", cores: Number.NaN, memoryBytes: 1 })
    assert.deepEqual(costs.of("codex"), codex, "a reading that isn't a number changes nothing")
    costs.save()
    assert.deepEqual(new FinCostModel(file).of("codex"), codex, "kept for the next host")
    // A burst of builds-sized readings doesn't move the light cost: they're builds.
    for (let at = 0; at < 50; at += 1) costs.add({ harness: "codex", cores: 8, memoryBytes: 4 * GB })
    assert.equal(costs.of("codex").cores, codex.cores)
    assert.ok(deviceCapacity({ cores: 14, memoryBytes: 36 * GB }, costs.cost({ codex: 1 })).atOnce > 17, "a Mac that measured lighter Fins takes more")
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

// ── The cloud: sandboxes the plan runs at once and the spend ceiling pays an hour of, times Fins per sandbox.
{
  assert.equal(cloudCapacity({}), undefined, "nothing bounds it without a plan or a ceiling")
  assert.equal(cloudCapacity({ planSandboxes: 32 }), 32)
  assert.equal(cloudCapacity({ planSandboxes: 32, finsPerSandbox: 4 }), 128, "a bigger sandbox runs several")
  assert.equal(cloudCapacity({ planSandboxes: 32, sandboxCentsPerHour: 20, dailySpendCents: 2_000, spentTodayCents: 1_000 }), 32, "the ceiling has room for more than the plan")
  assert.equal(cloudCapacity({ planSandboxes: 32, sandboxCentsPerHour: 20, dailySpendCents: 2_000, spentTodayCents: 1_900 }), 5, "near the ceiling it takes what an hour more pays for")
  assert.equal(cloudCapacity({ planSandboxes: 32, sandboxCentsPerHour: 20, dailySpendCents: 2_000, spentTodayCents: 2_500, runningSandboxes: 3 }), 3, "past it, only what runs")
}

// ── The device's number: its capacity, the governor under pressure, and the person's own number in place of both.
{
  let now = 0
  let own: number | undefined
  let reading: MacReading = { cores: 14, memoryBytes: 36 * GB, busyCores: 2 }
  const capacity = new FinCapacity({
    read: async () => reading,
    costs: new FinCostModel(),
    own: () => own,
    hardware: () => ({ cores: 14, memoryBytes: 36 * GB }),
    now: () => now,
  })
  await capacity.observe(0, {})
  assert.equal(capacity.atOnce(), 17)
  assert.deepEqual(capacity.reading(), { atOnce: 17, auto: 17, why: "14 cores, 36 GB · a Fin ≈ 0.35 core, 0.8 GB · room for 1 build", measured: false })
  own = 30
  assert.equal(capacity.atOnce(), 30, "the person's own number wins")
  assert.equal(capacity.reading().auto, 17)
  own = undefined
  reading = { ...reading, memoryPressure: true }
  for (let at = 0; at < 60; at += 1) {
    now += 10_000
    await capacity.observe(5, { claude: 5 })
  }
  const pressed = capacity.reading()
  assert.ok(pressed.atOnce < 17 && pressed.atOnce >= 9, JSON.stringify(pressed))
  assert.match(pressed.pressure ?? "", /memory pressure/)
  const fixed = new FinCapacity({ read: async () => reading, costs: new FinCostModel(), own: () => 3, fixed: 8 })
  assert.equal(fixed.atOnce(), 8, "MAKO_FIN_SLOTS sets a test host's whatever else")
}

// ── What a Fin costs here is learned from its processes, read only on the looks that pass the Fins at work.
{
  let now = 0
  let reads = 0
  let cpuSeconds = 100
  const table = async (): Promise<ProcessRow[]> => {
    reads += 1
    return [{ pid: 10, ppid: 1, rssKb: 400 * 1024, cpuPercent: 0, cpuSeconds, command: "/opt/codex/bin/codex app-server" }]
  }
  const costs = new FinCostModel()
  const capacity = new FinCapacity({
    read: async () => ({ cores: 14, memoryBytes: 36 * GB, busyCores: 2 }),
    costs,
    sampler: new FinCostSampler({ table, owned: () => [{ pid: 10, owner: "codex-fin" }], now: () => now }),
    own: () => undefined,
    hardware: () => ({ cores: 14, memoryBytes: 36 * GB }),
    now: () => now,
  })
  const fins = [{ conversation: "codex-fin", harness: "codex" }]
  await capacity.observe(1, { codex: 1 })
  assert.equal(reads, 0, "a start's look doesn't read every Fin's processes")
  await capacity.observe(0, {}, [])
  assert.equal(reads, 0, "the periodic look with no Fin at work reads no process table")
  for (let at = 0; at < 6; at += 1) {
    now += 10_000
    cpuSeconds += 1
    await capacity.observe(1, { codex: 1 }, fins)
  }
  assert.equal(reads, 6)
  const codex = costs.of("codex")
  assert.ok(codex.cores < PRIOR_COST.cores && codex.memoryBytes < PRIOR_COST.memoryBytes, `a lighter Fin than the prior moves its cost down: ${JSON.stringify(codex)}`)
  assert.deepEqual(costs.of("claude"), PRIOR_COST, "a harness not at work isn't read")
}

console.log("fin capacity: each machine's number from its hardware and its Fins' cost, steady under one busy minute")
