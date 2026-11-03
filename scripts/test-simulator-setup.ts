import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { HostJobs } from "@mako/host/base/host-jobs"
import { setupStep, type SetupStepId, type SimulatorSetup, XCODE_APP_STORE_URL } from "@mako/host/contracts/simulator-setup"
import { CLAIM_IDLE_MS, type SimulatorCaller, type SimulatorSummary } from "@mako/host/contracts/simulators"
import {
  chooseForms,
  chooseXcode,
  makoSimulators,
  parseCheck,
  parseDeveloperDir,
  parseDownloadLine,
  parseSimctlList,
  parseWantedRuntime,
  RUNTIME_NEEDS_BYTES,
  selects,
  setupFromFacts,
  type SetupFacts,
} from "@mako/host/control/simulators/setup-facts"
import { SimulatorSetupFollower, type Run } from "@mako/host/control/simulators/setup"
import { Simulators } from "@mako/host/control/simulators/simulators"
import { LocalSimulatorHost } from "@mako/host/control/simulators/local-host"
import { SimulatorUnsupported, type SimulatorHost } from "@mako/host/control/simulators/host"
import { PINNED_TOOLS } from "@mako/host/control/simulators/tools"

/**
 * Settings › Simulators' setup line, read from what Xcode's own tools say: the Command Line Tools alone (as on a Mac
 * that never had Xcode, whose words here are a real Mac's), an Xcode not finished, one without its runtime, every step
 * done, and one that was ready and broke. Then the one-Thread-at-a-time rules of `Simulators`.
 */

const scratch = await mkdtemp(join(tmpdir(), "mako-simulators-"))
after(() => rm(scratch, { recursive: true, force: true }))

/** What this Mac's Command Line Tools said, word for word, with no Xcode installed. */
const CLT = {
  developerDir: "/Library/Developer/CommandLineTools\n",
  xcodebuild: "xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance\n",
  simctl: 'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH\n',
}
const LICENSE_NEEDED = "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license.\n"
const XCODE = { path: "/Applications/Xcode.app", version: "26.1", build: "17B55" }
const XCODE_DEVELOPER = "/Applications/Xcode.app/Contents/Developer"

const RUNTIME_ID = "com.apple.CoreSimulator.SimRuntime.iOS-26-1"
const simctl = (devices: { udid: string; name: string; type: string }[] = [], runtimeAvailable = true) =>
  JSON.stringify({
    devicetypes: [
      { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro", name: "iPhone 16 Pro", productFamily: "iPhone" },
      { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", name: "iPhone 17 Pro", productFamily: "iPhone" },
      { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max", name: "iPhone 17 Pro Max", productFamily: "iPhone" },
      { identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M5", name: "iPad Pro 11-inch (M5)", productFamily: "iPad" },
      { identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB", name: "iPad Pro 13-inch (M4)", productFamily: "iPad" },
      { identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB", name: "iPad Pro 13-inch (M5)", productFamily: "iPad" },
      { identifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-11-46mm", name: "Apple Watch Series 11 (46mm)", productFamily: "Apple Watch" },
    ],
    runtimes: [
      { identifier: RUNTIME_ID, name: "iOS 26.1", version: "26.1", buildversion: "23B80", platform: "iOS", isAvailable: runtimeAvailable },
      { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-26-1", name: "watchOS 26.1", version: "26.1", platform: "watchOS", isAvailable: true },
    ],
    devices: {
      [RUNTIME_ID]: [
        { udid: "AAAA-PERSON", name: "iPhone 17 Pro", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", state: "Shutdown", isAvailable: true },
        ...devices.map((device) => ({ udid: device.udid, name: device.name, deviceTypeIdentifier: device.type, state: "Shutdown", isAvailable: runtimeAvailable })),
      ],
    },
  })
const MADE = [
  { udid: "MAKO-PHONE", name: "Mako iPhone 17 Pro", type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" },
  { udid: "MAKO-TABLET", name: "Mako iPad Pro 13-inch (M5)", type: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB" },
]
const SDKS = JSON.stringify([
  { canonicalName: "iphoneos26.1", platform: "iphoneos", sdkVersion: "26.1" },
  { canonicalName: "iphonesimulator26.1", platform: "iphonesimulator", sdkVersion: "26.1" },
  { canonicalName: "macosx26.1", platform: "macosx", sdkVersion: "26.1" },
])
const toolsInstalled = PINNED_TOOLS.map((tool) => ({ name: tool.name, version: tool.version, purpose: tool.purpose, license: tool.license, installed: tool.version }))
const toolsMissing = toolsInstalled.map(({ installed: _installed, ...tool }) => tool)

/** A Mac with only the Command Line Tools: the facts `readSetupFacts` reads on one. */
const cltOnly: SetupFacts = {
  platform: "darwin",
  mac: "macOS 26.6.2, arm64",
  freeBytes: 193e9,
  developerDir: "/Library/Developer/CommandLineTools",
  xcodes: [],
  license: "unknown",
  firstLaunch: "unknown",
  runtimes: [],
  devices: [],
  deviceTypes: [],
  tools: toolsMissing,
  consent: [],
  canTry: false,
  wasReady: false,
  waitingForXcode: false,
  checkedAt: 1,
}
const everythingDone: SetupFacts = {
  ...cltOnly,
  developerDir: XCODE_DEVELOPER,
  xcodes: [XCODE],
  license: "done",
  firstLaunch: "done",
  ...parseSimctlList(simctl(MADE)),
  wantedRuntime: "26.1",
  tools: toolsInstalled,
  consent: [{ folder: "/Users/ada/shop", allowed: true, at: 5 }],
}

// SAFETY: a setup has one step of each ID, so every ID is a key.
const states = (setup: SimulatorSetup) => Object.fromEntries(setup.steps.map((step) => [step.id, step.state])) as Record<SetupStepId, string>

test("each check reads Xcode's own words, and the Command Line Tools' refusal is not a license to accept", () => {
  assert.equal(parseDeveloperDir(CLT.developerDir), "/Library/Developer/CommandLineTools")
  assert.equal(parseDeveloperDir(""), null)
  assert.equal(parseCheck(1, CLT.xcodebuild, "license"), "unknown")
  assert.equal(parseCheck(72, CLT.simctl, "first-launch"), "unknown")
  assert.equal(parseCheck(69, LICENSE_NEEDED, "license"), "needed")
  assert.equal(parseCheck(1, "", "first-launch"), "needed")
  assert.equal(parseCheck(0, "", "license"), "done")
  assert.equal(parseCheck(null, "spawn ENOENT", "license"), "unknown")
})

test("Mako uses the Xcode the developer folder points into, else the newest", () => {
  const beta = { path: "/Applications/Xcode-beta.app", version: "27.0" }
  assert.equal(selects("/Library/Developer/CommandLineTools", XCODE), false)
  assert.equal(selects(XCODE_DEVELOPER, XCODE), true)
  assert.equal(selects("/Applications/Xcode.app.old/Contents/Developer", XCODE), false)
  assert.deepEqual(chooseXcode([XCODE, beta], XCODE_DEVELOPER), XCODE)
  assert.deepEqual(chooseXcode([XCODE, beta], "/Library/Developer/CommandLineTools"), beta)
  assert.equal(chooseXcode([], null), undefined)
})

test("simctl's list gives iOS runtimes, their simulators and the newest iPhone Pro and 13-inch iPad Pro", () => {
  const list = parseSimctlList(simctl())
  assert.deepEqual(list.runtimes.map((runtime) => runtime.name), ["iOS 26.1"])
  assert.deepEqual(list.devices.map((device) => device.name), ["iPhone 17 Pro"])
  const forms = chooseForms(list.deviceTypes)
  assert.equal(forms.phone?.name, "iPhone 17 Pro")
  assert.equal(forms.tablet?.name, "iPad Pro 13-inch (M5)")
  assert.equal(parseWantedRuntime(SDKS), "26.1")
})

test("Mako's simulators are its own: the person's iPhone 17 Pro is never taken for one", () => {
  const wouldMake = makoSimulators(parseSimctlList(simctl()))
  assert.deepEqual(wouldMake.map((simulator) => [simulator.name, simulator.udid]), [["Mako iPhone 17 Pro", undefined], ["Mako iPad Pro 13-inch (M5)", undefined]])
  const made = makoSimulators(parseSimctlList(simctl(MADE)))
  assert.deepEqual(made.map((simulator) => simulator.udid), ["MAKO-PHONE", "MAKO-TABLET"])
  assert.equal(makoSimulators(parseSimctlList(simctl(MADE, false))).every((simulator) => !simulator.udid), true)
})

test("download progress is read in either decimal mark, and a line with no percentage says nothing", () => {
  assert.deepEqual(parseDownloadLine("Downloading iOS 17.2 Simulator (21C62): 7.8% (572.8 MB of 7.35 GB)"), { fraction: 0.078, doneBytes: 572_800_000, totalBytes: 7_350_000_000 })
  assert.deepEqual(parseDownloadLine("Downloading iOS 26.1 Simulator (23B80): 7,8 % (572,8 MB of 7,35 GB)"), { fraction: 0.078, doneBytes: 572_800_000, totalBytes: 7_350_000_000 })
  assert.deepEqual(parseDownloadLine("Downloading iOS 26.1 Simulator (23B80): 100%"), { fraction: 1 })
  assert.equal(parseDownloadLine("Finding content..."), undefined)
})

test("with only the Command Line Tools, Xcode is the person's step and the tools can go ahead without it", () => {
  const setup = setupFromFacts(cltOnly)
  assert.equal(setup.phase, "setting-up")
  assert.deepEqual(states(setup), { xcode: "yours", finish: "later", runtime: "later", simulators: "later", tools: "yours", agents: "yours", try: "later" })
  assert.equal(setupStep(setup, "xcode")?.fix, "get-xcode")
  assert.equal(setupStep(setup, "xcode")?.developerDir, "/Library/Developer/CommandLineTools")
  assert.equal(setupStep(setup, "tools")?.fix, "install-tools")
  assert.equal(states(setupFromFacts({ ...cltOnly, waitingForXcode: true })).xcode, "working")
})

test("too little room for Xcode holds the step, and says how much", () => {
  const xcode = setupStep(setupFromFacts({ ...cltOnly, freeBytes: 12e9 }), "xcode")
  assert.equal(xcode?.state, "stuck")
  assert.match(xcode?.problem ?? "", /30 GB free.*12 GB/)
  assert.equal(xcode?.disk.needBytes, 40e9)
})

test("an Xcode not yet finished is one password prompt away, and nothing past it can be asked", () => {
  const setup = setupFromFacts({ ...cltOnly, xcodes: [XCODE], license: "needed", firstLaunch: "needed" })
  assert.deepEqual(states(setup), { xcode: "done", finish: "yours", runtime: "later", simulators: "later", tools: "yours", agents: "yours", try: "later" })
  const finish = setupStep(setup, "finish")
  assert.deepEqual([finish?.selected, finish?.license, finish?.firstLaunch, finish?.fix], [false, "needed", "needed", "finish-xcode"])
  assert.equal(setupStep(setup, "xcode")?.disk.needBytes, RUNTIME_NEEDS_BYTES)
})

test("with the license accepted, the runtime is next, and Mako's simulators after it", () => {
  const noRuntime = setupFromFacts({ ...everythingDone, runtimes: [], devices: [] })
  assert.equal(states(noRuntime).runtime, "yours")
  assert.equal(setupStep(noRuntime, "runtime")?.fix, "download-runtime")
  assert.equal(states(noRuntime).simulators, "later")
  const downloading = setupFromFacts({ ...everythingDone, runtimes: [], devices: [], progress: { step: "runtime", fraction: 0.4, startedAt: 1 } })
  assert.equal(states(downloading).runtime, "working")
  assert.equal(downloading.progress?.fraction, 0.4)
  const unmade = setupFromFacts({ ...everythingDone, ...parseSimctlList(simctl()) })
  assert.equal(states(unmade).simulators, "yours")
  assert.equal(setupStep(unmade, "simulators")?.fix, "create-simulators")
})

test("every step done is ready; the try waits for a host that can stream", () => {
  const setup = setupFromFacts(everythingDone)
  assert.equal(setup.phase, "ready")
  assert.deepEqual(states(setup), { xcode: "done", finish: "done", runtime: "done", simulators: "done", tools: "done", agents: "done", try: "later" })
  assert.match(setupStep(setup, "try")?.problem ?? "", /built next/)
  const canTry = setupFromFacts({ ...everythingDone, canTry: true })
  assert.deepEqual([states(canTry).try, setupStep(canTry, "try")?.fix], ["yours", "try"])
  assert.equal(states(setupFromFacts({ ...everythingDone, canTry: true, tried: { at: 9, firstFrameMs: 840 } })).try, "done")
})

test("ready once, then a runtime gone or a new Xcode's license is a breakage with its repair", () => {
  const runtimeGone = setupFromFacts({ ...everythingDone, wasReady: true, runtimes: [], devices: [] })
  assert.equal(runtimeGone.phase, "broken")
  assert.equal(setupStep(runtimeGone, "runtime")?.state, "stuck")
  assert.equal(setupStep(runtimeGone, "runtime")?.fix, "download-runtime")
  assert.match(setupStep(runtimeGone, "runtime")?.problem ?? "", /isn't installed any more/)
  const updated = setupFromFacts({ ...everythingDone, wasReady: true, license: "needed", runtimes: [], devices: [], deviceTypes: [] })
  assert.equal(updated.phase, "broken")
  assert.deepEqual([setupStep(updated, "finish")?.state, setupStep(updated, "finish")?.fix], ["stuck", "finish-xcode"])
  assert.equal(setupFromFacts({ ...everythingDone, wasReady: true, consent: [] }).phase, "ready")
})

test("off macOS there is nothing to set up", () => {
  assert.equal(setupFromFacts({ ...cltOnly, platform: "linux" }).phase, "unavailable")
})

/** A Mac's commands as a table: each answer by the command line it's given. */
type Answer = { code: number | null; stdout?: string; stderr?: string }

/** A runner answering each command line by its prefix; an answer may be a promise, for a prompt the person leaves open. */
function commands(answers: Record<string, Answer | Promise<Answer>>) {
  const ran: string[] = []
  const run: Run = async (file, args) => {
    const line = [file, ...args].join(" ")
    ran.push(line)
    const answer = (await Object.entries(answers).find(([prefix]) => line.startsWith(prefix))?.[1]) ?? { code: 127, stderr: `no fixture for ${line}` }
    return { code: answer.code, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" }
  }
  return { run, ran }
}

test("the follower on a Mac with only the Command Line Tools: one read, Get Xcode opens the App Store and watches for it", async () => {
  const dataRoot = join(scratch, "clt")
  const applications = join(scratch, "clt-applications")
  await mkdir(applications, { recursive: true })
  const { run, ran } = commands({
    "/usr/bin/xcode-select -p": { code: 0, stdout: CLT.developerDir },
    "/usr/bin/open": { code: 0 },
  })
  const jobs = new HostJobs()
  const heard: SimulatorSetup[] = []
  const follower = new SimulatorSetupFollower({ dataRoot, jobs, emit: (setup) => heard.push(setup), run, platform: "darwin", applications: [applications] })
  const [first, second] = await Promise.all([follower.read(), follower.read()])
  assert.equal(first, second)
  assert.equal(first.phase, "setting-up")
  assert.equal(ran.filter((line) => line.startsWith("/usr/bin/xcode-select")).length, 1)
  assert.equal(ran.some((line) => line.includes("simctl") || line.includes("xcodebuild")), false)

  const pressed = await follower.press("get-xcode")
  assert.ok(ran.includes(`/usr/bin/open ${XCODE_APP_STORE_URL}`))
  assert.equal(states(pressed).xcode, "working")
  assert.ok(JSON.parse(await readFile(join(dataRoot, "simulators", "setup.json"), "utf8")).waitingSince > 0)
  assert.equal(heard.at(-1)?.steps[0]?.state, "working")
  follower.stop()
})

test("the follower finds a finished Xcode in Applications and asks it through its own folder", async () => {
  const dataRoot = join(scratch, "xcode")
  const applications = join(scratch, "xcode-applications")
  await mkdir(join(applications, "Xcode.app", "Contents", "Developer", "usr", "bin"), { recursive: true })
  await writeFile(join(applications, "Xcode.app", "Contents", "Developer", "usr", "bin", "xcodebuild"), "")
  // An App Store download in progress has no xcodebuild yet.
  await mkdir(join(applications, "Xcode-beta.app", "Contents"), { recursive: true })
  const developer = join(applications, "Xcode.app", "Contents", "Developer")
  const { promise: prompt, resolve: closePrompt } = Promise.withResolvers<Answer>()
  const { run, ran } = commands({
    "/usr/bin/xcode-select -p": { code: 0, stdout: CLT.developerDir },
    [`/usr/bin/plutil -convert json -o - ${join(applications, "Xcode.app", "Contents", "Info.plist")}`]: { code: 0, stdout: JSON.stringify({ CFBundleShortVersionString: "26.1" }) },
    [`/usr/bin/plutil -convert json -o - ${join(applications, "Xcode.app", "Contents", "version.plist")}`]: { code: 0, stdout: JSON.stringify({ ProductBuildVersion: "17B55" }) },
    [`${developer}/usr/bin/xcodebuild -license check`]: { code: 0 },
    [`${developer}/usr/bin/xcodebuild -checkFirstLaunchStatus`]: { code: 0 },
    [`${developer}/usr/bin/xcodebuild -showsdks -json`]: { code: 0, stdout: SDKS },
    "/usr/bin/xcrun simctl list -j": { code: 0, stdout: simctl() },
    "/usr/bin/osascript": prompt,
  })
  const follower = new SimulatorSetupFollower({ dataRoot, jobs: new HostJobs(), emit: () => {}, run, platform: "darwin", applications: [applications] })
  const setup = await follower.read()
  assert.deepEqual(setupStep(setup, "xcode")?.xcode, { path: join(applications, "Xcode.app"), version: "26.1", build: "17B55" })
  assert.equal(setupStep(setup, "finish")?.selected, false)
  assert.equal(states(setup).finish, "yours")
  assert.equal(states(setup).runtime, "done")
  assert.equal(states(setup).simulators, "yours")

  const started = await follower.press("finish-xcode")
  assert.equal(started.progress?.step, "finish")
  assert.equal(states(started).finish, "working")
  await assert.rejects(follower.press("download-runtime"), /still on the step before/)
  closePrompt({ code: 1, stderr: "execution error: User canceled. (-128)" })
  await follower.settled()
  const closed = follower.current()
  assert.ok(closed)
  assert.equal(states(closed).finish, "yours")
  assert.equal(closed.progress, undefined)
  assert.equal(closed.failure?.fix, "finish-xcode")
  assert.match(closed.failure?.message ?? "", /password prompt was closed/)
  const script = ran.find((line) => line.startsWith("/usr/bin/osascript")) ?? ""
  assert.match(script, /xcode-select -s .* && .*xcodebuild' -license accept && .*xcodebuild' -runFirstLaunch/)
  assert.match(script, /with administrator privileges/)
  follower.stop()
})

test("consent is per project and revocable", async () => {
  const dataRoot = join(scratch, "consent")
  const { run } = commands({ "/usr/bin/xcode-select -p": { code: 0, stdout: CLT.developerDir } })
  const follower = new SimulatorSetupFollower({ dataRoot, jobs: new HostJobs(), emit: () => {}, run, platform: "darwin", applications: [] })
  await follower.press("allow-agents", { folder: "/Users/ada/shop", allowed: true })
  await follower.press("allow-agents", { folder: "/Users/ada/bank", allowed: false })
  assert.deepEqual((await follower.consent()).map((entry) => [entry.folder, entry.allowed]).sort(), [["/Users/ada/bank", false], ["/Users/ada/shop", true]])
  const missing = await follower.press("allow-agents")
  assert.match(missing.failure?.message ?? "", /which project/)
  follower.stop()
})

/** A host that does what it's told and remembers it, standing in for a Mac with Xcode. */
function fakeHost(): SimulatorHost & { done: string[] } {
  const simulator: SimulatorSummary = { hostId: "local", id: "MAKO-PHONE", name: "Mako iPhone 17 Pro", platform: "ios", runtime: "iOS 26.1", form: "phone", state: "shutdown" }
  const done: string[] = []
  return {
    id: "local",
    label: "This Mac",
    kind: "local",
    done,
    summary: async () => ({ id: "local", label: "This Mac", kind: "local", platforms: { ios: { ready: true }, android: { ready: false, blocker: "not-built", why: "later" } } }),
    list: async () => [simulator],
    boot: async (id) => void done.push(`boot ${id}`),
    act: async (id, action) => void done.push(`${action.kind} ${id}`),
    read: async () => ({ state: { scrollTop: 0 } }),
    screenshot: async () => ({ path: "/tmp/shot.png", width: 402, height: 874 }),
    record: async () => {
      throw new SimulatorUnsupported("Recording comes later.")
    },
  }
}

test("one Thread drives a simulator; others are refused, the person can take it, and the loser's late action is stale", async () => {
  let now = 1_000
  const consent = [{ folder: "/Users/ada/shop", allowed: true, at: 1 }]
  const host = fakeHost()
  const simulators = new Simulators({ hosts: [host], consent: async () => consent, now: () => now })
  const agent = (thread: string, folder = "/Users/ada/shop"): SimulatorCaller => ({ kind: "agent", thread, conversation: `c-${thread}`, folder, title: `Thread ${thread}` })

  const refused = await simulators.open(agent("x", "/Users/ada/bank"), { simulator: "MAKO-PHONE" })
  assert.equal("refused" in refused && refused.refused, "not-allowed")

  const notOpen = await simulators.act(agent("a"), { simulator: "MAKO-PHONE", action: { kind: "home" } })
  assert.equal("refused" in notOpen && notOpen.refused, "not-open")

  const opened = await simulators.open(agent("a", "/Users/ada/shop/packages/web"), { simulator: "MAKO-PHONE", url: "https://example.com" })
  assert.ok("claim" in opened)
  assert.deepEqual(host.done, ["boot MAKO-PHONE", "open-url MAKO-PHONE"])

  const held = await simulators.open(agent("b"), { simulator: "MAKO-PHONE" })
  assert.equal("refused" in held && held.refused, "held")
  assert.equal("refused" in held && held.holder?.title, "Thread a")

  const watched = await simulators.shot(agent("b"), { simulator: "MAKO-PHONE" })
  assert.deepEqual(watched, { path: "/tmp/shot.png", width: 402, height: 874 })

  const acted = await simulators.act(agent("a"), { simulator: "MAKO-PHONE", action: { kind: "tap", at: { x: 10, y: 20 } } })
  assert.ok("ms" in acted)

  const taken = await simulators.open({ kind: "person" }, { simulator: "MAKO-PHONE" })
  assert.ok("claim" in taken && taken.claim.generation > ("claim" in opened ? opened.claim.generation : 0))
  const late = await simulators.act(agent("a"), { simulator: "MAKO-PHONE", action: { kind: "home" } })
  assert.equal("refused" in late && late.refused, "stale")

  assert.deepEqual(await simulators.release({ kind: "person" }, { simulator: "MAKO-PHONE" }), { released: true })
  const reopened = await simulators.open(agent("b"), { simulator: "MAKO-PHONE" })
  assert.ok("claim" in reopened)
  now += CLAIM_IDLE_MS
  const listed = await simulators.list({ kind: "person" })
  assert.equal(listed.simulators[0]?.claim, undefined)
  const idle = await simulators.act(agent("b"), { simulator: "MAKO-PHONE", action: { kind: "home" } })
  assert.equal("refused" in idle && idle.refused, "stale")

  await simulators.open(agent("b"), { simulator: "MAKO-PHONE" })
  const unsupported = await simulators.record(agent("b"), { simulator: "MAKO-PHONE", recording: "start" })
  assert.deepEqual(unsupported, { refused: "unsupported", why: "Recording comes later." })
})

test("on a Mac without Xcode, every door hears why, in the setup line's words", async () => {
  const setup = setupFromFacts(cltOnly)
  const simulators = new Simulators({ hosts: [new LocalSimulatorHost(async () => setup)], consent: async () => [] })
  const listed = await simulators.list({ kind: "person" })
  assert.deepEqual(listed.hosts[0]?.platforms.ios, { ready: false, blocker: "no-xcode", why: "This Mac has no Xcode, so no iOS Simulator.", fix: "Settings › Simulators" })
  assert.deepEqual(listed.simulators, [])
  const opened = await simulators.open({ kind: "person" }, { simulator: "anything" })
  assert.deepEqual(opened, { refused: "unavailable", why: "This Mac has no Xcode, so no iOS Simulator." })

  const ready = new LocalSimulatorHost(async () => setupFromFacts(everythingDone))
  assert.equal((await ready.summary()).platforms.ios.ready, false)
  assert.equal((await ready.list()).length, 2)
  await assert.rejects(ready.boot(), { name: SimulatorUnsupported.name, message: /built once it can be checked against a real Xcode/ })
})
