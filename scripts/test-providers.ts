import { claudeRuntime } from "@mako/host/harnesses/claude/runtime"
import { OPENCODE_OLDEST } from "@mako/host/harnesses/opencode/version"
import {
  codexExecutableCandidates,
  resolveCodexExecutable,
} from "@mako/host/harnesses/codex/executable"
import assert from "node:assert/strict"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import { z } from "zod"
import { resolveAcpConfigValue } from "@mako/host/harnesses/acp-config"
import {
  environmentForExecutable,
  resolveExecutable,
} from "@mako/host/base/executable"
import { NeededActivity, ProviderActivityEngine } from "@mako/host/threads/activity-engine"
import { CONFIRMED_EVERY_MS, ProviderProfileCache } from "@mako/host/harnesses/provider-profile-cache"
import { mock } from "node:test"
import {
  claudeProcessProbeFor,
  parseClaudeActiveSessions,
} from "@mako/host/harnesses/claude/process-probe"
import { parseCodexOpenSessionPaths } from "@mako/host/harnesses/codex/process-probe"
import { parseCursorOpenSessionPaths } from "@mako/host/harnesses/cursor/process-probe"
import {
  grokProcessProbe,
  parseGrokActiveSessions,
} from "@mako/host/harnesses/grok/process-probe"
import {
  createDevinProcessProbe,
  parseDevinProcesses,
  type DevinProcess,
} from "@mako/host/harnesses/devin/process-probe"
import type { ProviderAccountCapability } from "@mako/host/harnesses/account-capability"
import {
  processIdentityMatches,
  processStartMatches,
} from "@mako/host/base/process-liveness"
import type { ProviderProcessProbe } from "@mako/host/threads/harnesses"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import type { NativeRunner } from "@mako/host/harnesses/native-runner"
import type { HarnessProfile } from "@mako/host/contracts/providers-acp"
import { ProviderRegistry } from "@mako/host/harnesses/registry"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)

const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail("Timed out waiting for provider activity")
}

assert.equal(
  processStartMatches(
    "2026-08-30T12:00:00.000Z",
    Date.parse("2026-08-30T12:00:20.000Z")
  ),
  true
)
assert.equal(
  processStartMatches(
    "2026-08-30T12:00:00.000Z",
    Date.parse("2026-08-30T12:02:00.000Z")
  ),
  false
)
assert.deepEqual(
  parseCodexOpenSessionPaths(
    "p10\nn/Users/test/.codex/sessions/one.jsonl\nn/tmp/other.jsonl\np11\nn/Users/test/.codex/sessions/two.jsonl\n",
    "/Users/test/.codex/sessions"
  ),
  [
    "/Users/test/.codex/sessions/one.jsonl",
    "/Users/test/.codex/sessions/two.jsonl",
  ]
)
assert.deepEqual(
  parseClaudeActiveSessions([
    { sessionId: "claude-one", state: "working" },
    { sessionId: "claude-idle", status: "idle" },
    { sessionId: "claude-unknown" },
    {
      sessionId: "claude-two",
      status: "waiting",
      waitingFor: "permission prompt",
    },
  ]),
  [
    { nativeId: "claude-one", status: "active", detail: undefined },
    { nativeId: "claude-idle", status: "open", detail: undefined },
    { nativeId: "claude-unknown", status: "open", detail: undefined },
    {
      nativeId: "claude-two",
      status: "needs-input",
      detail: "permission prompt",
    },
  ]
)
assert.deepEqual(
  parseCursorOpenSessionPaths(
    "p10\nn/Users/test/.cursor/chats/hash/one/store.db\nn/tmp/store.db\nn/Users/test/.cursor/acp-sessions/two/store.db\n",
    ["/Users/test/.cursor/chats", "/Users/test/.cursor/acp-sessions"]
  ),
  [
    "/Users/test/.cursor/chats/hash/one/store.db",
    "/Users/test/.cursor/acp-sessions/two/store.db",
  ]
)
assert.deepEqual(
  parseGrokActiveSessions(
    [
      { session_id: "grok-one", pid: 10 },
      { session_id: "grok-dead", pid: 11 },
    ],
    (pid) => pid === 10
  ),
  [{ nativeId: "grok-one", status: "open" }]
)
assert.deepEqual(
  parseDevinProcesses(
    "  501 Thu Oct  1 02:30:00 2026     /Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin\n" +
      "  502 Thu Oct  1 02:30:00 2026     /usr/bin/devinish\n" +
      "  503 Thu Oct  1 02:31:00 2026     devin\n"
  ),
  [
    { pid: 501, startedAt: Date.parse("Thu Oct 1 02:30:00 2026") },
    { pid: 503, startedAt: Date.parse("Thu Oct 1 02:31:00 2026") },
  ]
)
{
  const locks = await mkdtemp(join(tmpdir(), "mako-devin-locks-"))
  try {
    const now = Date.now()
    let running: DevinProcess[] = [
      { pid: 700, startedAt: now - 60_000 },
      { pid: 701, startedAt: now - 10_000 },
    ]
    let asked = 0
    const probe = createDevinProcessProbe({
      locks,
      processes: async () => (asked++, running),
    })
    const lock = async (session: string, pid: number, at: number) => {
      await writeFile(join(locks, `${session}.lock`), String(pid))
      await utimes(join(locks, `${session}.lock`), at / 1000, at / 1000)
    }
    await lock("open-one", 700, now - 30_000)
    await lock("recycled-pid", 701, now - 30_000)
    await lock("dead-pid", 999, now - 5_000)
    await lock("ancient", 700, now - 86_400_000)
    const signal = new AbortController().signal
    assert.deepEqual(
      await probe.probe(signal),
      {
        kind: "available",
        sessions: [{ nativeId: "open-one", status: "open" }],
      },
      "a lock is open only when a running devin started before writing it"
    )
    await lock("open-one", 701, now - 1_000)
    assert.deepEqual(
      await probe.probe(signal),
      {
        kind: "available",
        sessions: [{ nativeId: "open-one", status: "open" }],
      },
      "a session another devin loads is re-read when its lock changes"
    )
    running = []
    await rm(locks, { recursive: true })
    assert.deepEqual(
      await probe.probe(signal),
      { kind: "available", sessions: [] },
      "with no devin running, no lock is read"
    )
    assert.equal(asked, 3)
  } finally {
    await rm(locks, { recursive: true, force: true })
  }
}
let probeAvailable = true
let probeNeedsInput = false
const activityProbe = {
  provider: "test",
  pollIntervalMs: 5,
  staleAfterMs: 10,
  async probe() {
    return probeAvailable
      ? {
          kind: "available",
          sessions: [
            {
              nativeId: "live",
              status: probeNeedsInput ? "needs-input" : "active",
            },
          ],
        }
      : { kind: "unavailable", reason: "failed" }
  },
} satisfies ProviderProcessProbe
const activityUpdates: string[][] = []
const activityEngine = new ProviderActivityEngine([activityProbe])
activityEngine.onChange((snapshot) =>
  activityUpdates.push(
    snapshot.sessions.flatMap((session) =>
      session.nativeId ? [`${session.nativeId}:${session.status}`] : []
    )
  )
)
activityEngine.start()
await waitFor(() => activityUpdates.length === 1)
probeNeedsInput = true
await waitFor(() => activityUpdates.length === 2)
probeAvailable = false
await waitFor(() => activityUpdates.length === 3)
activityEngine.stop()
assert.deepEqual(activityUpdates, [["live:active"], ["live:needs-input"], []])

// A harness with nothing open looks again only at its idle interval, not every few milliseconds of its cadence, and a
// provider process Mako starts nudges it to look at once; once something is open it keeps its cadence.
{
  let looks = 0
  let open = false
  const quiet = new ProviderActivityEngine([{
    provider: "quiet",
    pollIntervalMs: 5,
    idlePollMs: 60_000,
    async probe() {
      looks += 1
      return { kind: "available", sessions: open ? [{ nativeId: "opened", status: "active" }] : [] }
    },
  } satisfies ProviderProcessProbe])
  const seen: string[][] = []
  quiet.onChange((snapshot) => seen.push(snapshot.sessions.map((session) => session.nativeId ?? "")))
  quiet.start()
  await waitFor(() => looks === 1)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(looks, 1, "nothing open: no look at the 5 ms cadence, only at the idle minute")
  open = true
  quiet.nudge()
  await waitFor(() => seen.length === 1)
  assert.deepEqual(seen, [["opened"]], "a nudge looks at once and finds what opened")
  const after = looks
  await waitFor(() => looks >= after + 3)
  quiet.stop()
}

// Nobody reading the answer, the harnesses aren't looked at: an idle host asked each one every half minute, which
// alone kept its probes' child running. A reader coming on looks at once, and one going rests it again with what it
// last read; whoever must know while it rests gets one look made for the ask, shared by everyone asking then.
{
  let looks = 0
  let open = false
  let wanted = false
  const engine = new ProviderActivityEngine([{
    provider: "rested",
    pollIntervalMs: 5,
    idlePollMs: 5,
    async probe() {
      looks += 1
      await new Promise((resolve) => setTimeout(resolve, 2))
      return { kind: "available", sessions: open ? [{ nativeId: "opened", status: "open" }] : [] }
    },
  } satisfies ProviderProcessProbe])
  const seen: string[][] = []
  engine.onChange((snapshot) => seen.push(snapshot.sessions.map((session) => session.nativeId ?? "")))
  const need = new NeededActivity(engine, () => wanted, 40)
  need.follow()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(looks, 0, "with no reader, no harness is looked at, not even once as the host starts")

  open = true
  assert.deepEqual(await Promise.all([need.settled(), need.settled()]), [true, true], "an ask while it rests waits for a look")
  assert.equal(looks, 1, "one look answers everyone asking together")
  assert.deepEqual(seen, [["opened"]], "and what it found is said before the ask goes on")
  assert.equal(await need.settled(), false, "an ask just after is answered by that look")
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(looks, 1, "the ask didn't start the engine")
  assert.equal(await need.settled(), true, "a later ask looks again")
  assert.equal(looks, 2)

  wanted = true
  open = false
  need.follow()
  assert.equal(await need.settled(), true, "a reader coming on looks at once, and an ask then waits for that look")
  assert.deepEqual(seen, [["opened"], []], "which says what changed while nobody looked")
  const running = looks
  await waitFor(() => looks >= running + 3)
  assert.equal(await need.settled(), false, "while it looks, an ask is answered from what it holds")

  wanted = false
  need.follow()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const rested = looks
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(looks, rested, "the last reader gone, it rests again")
  engine.stop()
}

const claudeProbeHome = await mkdtemp(join(tmpdir(), "mako-claude-probe-"))
try {
  const registry = join(claudeProbeHome, ".claude", "sessions")
  await mkdir(registry, { recursive: true })
  await writeFile(
    join(registry, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: "claude-registry-session",
      state: "working",
    })
  )
  assert.deepEqual(
    await claudeProcessProbeFor(claudeProbeHome).probe(
      new AbortController().signal
    ),
    {
      kind: "available",
      sessions: [
        {
          nativeId: "claude-registry-session",
          status: "active",
          detail: undefined,
        },
      ],
    }
  )
  const originalPath = process.env.PATH
  const originalGrokHome = process.env.GROK_HOME
  try {
    await writeFile(
      join(registry, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: "unverifiable",
        state: "working",
        startedAt: Date.now(),
      })
    )
    process.env.PATH = registry
    process.env.GROK_HOME = registry
    await writeFile(
      join(registry, "active_sessions.json"),
      JSON.stringify([
        {
          pid: process.pid,
          session_id: "grok-unverifiable",
          opened_at: Date.now(),
        },
      ])
    )
    assert.deepEqual(
      await grokProcessProbe.probe(new AbortController().signal),
      { kind: "unavailable", reason: "failed" },
      "A missing process-query executable is not an empty Grok registry"
    )
    await rm(join(registry, "active_sessions.json"))
    await assert.rejects(
      processIdentityMatches({
        pid: process.pid,
        startedAt: Date.now(),
        signal: new AbortController().signal,
      })
    )
    assert.deepEqual(
      await claudeProcessProbeFor(claudeProbeHome).probe(
        new AbortController().signal
      ),
      { kind: "unavailable", reason: "failed" },
      "A failed identity query must not report live or idle activity"
    )
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    if (originalGrokHome === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = originalGrokHome
  }
} finally {
  await rm(claudeProbeHome, { recursive: true, force: true })
}

const cursorModelOption = {
  type: "select",
  id: "model",
  name: "Model",
  currentValue: "claude-opus-5[thinking=true,context=300k,effort=high]",
  options: [
    {
      value: "claude-opus-5[thinking=true,context=300k,effort=high]",
      name: "claude-opus-5",
    },
  ],
} satisfies SessionConfigOption
assert.equal(
  resolveAcpConfigValue(cursorModelOption, "claude-opus-5"),
  "claude-opus-5[thinking=true,context=300k,effort=high]"
)

const executableHome = await mkdtemp(join(tmpdir(), "mako-executable-"))
try {
  const bin = join(
    executableHome,
    ".nvm",
    "versions",
    "node",
    "v24.19.0",
    "bin"
  )
  const codex = join(bin, "codex")
  await mkdir(bin, { recursive: true })
  await writeFile(codex, "#!/bin/sh\nexit 0\n")
  await chmod(codex, 0o755)
  assert.equal(
    resolveExecutable("codex", { PATH: "/usr/bin:/bin" }, executableHome),
    codex
  )
  assert.equal(
    environmentForExecutable(codex, { PATH: "/usr/bin:/bin" }).PATH,
    `${bin}:/usr/bin:/bin`
  )
} finally {
  await rm(executableHome, { recursive: true, force: true })
}

const missingCodex = { CODEX_EXECUTABLE: join(executableHome, "missing-codex") }
assert.deepEqual(codexExecutableCandidates(missingCodex), [])
assert.equal(await resolveCodexExecutable(missingCodex), null)
await assert.rejects(
  providerHost.profiles.get("codex")!.load(missingCodex),
  /selected Codex executable/
)

const cacheDir = await mkdtemp(join(tmpdir(), "mako-provider-cache-"))
const cachePath = join(cacheDir, "profiles.json")
let cacheNow = Date.now()
const cachedProfile = {
  id: "cursor",
  label: "Cursor",
  available: true,
  transport: "acp",
  models: [],
} satisfies HarnessProfile
try {
  // A model list is the account's: one entry and one snapshot for it, and a line for each folder's own defaults.
  const clock = mock.method(Date, "now", () => cacheNow)
  const account = "cursor:default:"
  const listed = { ...cachedProfile, models: [{ id: "model-one", label: "One", options: [] }], defaultModel: "model-one" } satisfies HarnessProfile
  const firstCache = new ProviderProfileCache(cachePath)
  assert.equal(await firstCache.put(account, `${account}/work/one`, { ...listed, settings: { model: "model-one" }, configuredModel: "model-one" }, "runtime-1"), true)
  for (let folder = 0; folder < 30; folder++)
    await firstCache.put(account, `${account}/work/folder-${folder}`, listed, "runtime-1")
  const restartedCache = new ProviderProfileCache(cachePath)
  assert.deepEqual(await restartedCache.get(account, `${account}/work/one`), {
    profile: { ...listed, settings: { model: "model-one" }, configuredModel: "model-one" }, savedAt: cacheNow, stamp: "runtime-1",
  }, "the next host reads the account's list with the folder's own defaults")
  assert.equal(await restartedCache.get(account, `${account}/work/never`), null, "a folder never discovered has no snapshot of its own")
  assert.deepEqual((await restartedCache.catalog(account))?.profile, listed, "and lists the account's models, without another folder's defaults")
  assert.equal(await restartedCache.get("cursor:other:", `cursor:other:/work/one`), null, "nothing of one account answers for another")
  assert.equal(await restartedCache.catalog("cursor:other:"), null)
  assert.deepEqual(await restartedCache.nearest("cursor:"), listed)
  const cacheFileSchema = z.object({
    entries: z.record(z.string(), z.unknown()),
    snapshots: z.record(z.string(), z.unknown()),
    folders: z.record(z.string(), z.unknown()),
  })
  const stored = cacheFileSchema.parse(JSON.parse(await readFile(cachePath, "utf8")))
  assert.deepEqual(Object.keys(stored.entries), [account], "thirty folders of an account are one entry")
  assert.equal(Object.keys(stored.snapshots).length, 1)
  assert.equal(Object.keys(stored.folders).length, 31)

  // A discovery that found what is kept writes nothing; an hour on it says the list was confirmed.
  const written = async () => (await stat(cachePath)).ino
  const before = await written()
  cacheNow += 60_000
  assert.equal(await firstCache.put(account, `${account}/work/one`, { ...listed, settings: { model: "model-one" }, configuredModel: "model-one" }, "runtime-1"), false)
  assert.equal(await written(), before, "an unchanged snapshot is not written again")
  assert.equal((await new ProviderProfileCache(cachePath).catalog(account))?.savedAt, cacheNow - 60_000)
  assert.equal(await firstCache.put(account, `${account}/work/one`, { ...listed, settings: { model: "model-one" } }, "runtime-1"), true, "a folder whose defaults changed is")
  assert.equal(await firstCache.put(account, `${account}/work/one`, { ...listed, models: [] }, "runtime-1"), true, "and a list that changed")
  await firstCache.put(account, `${account}/work/one`, listed, "runtime-1")
  const confirmed = await written()
  cacheNow += CONFIRMED_EVERY_MS
  assert.equal(await firstCache.put(account, `${account}/work/one`, listed, "runtime-1"), true)
  assert.notEqual(await written(), confirmed, "an unchanged list is stamped as confirmed once an hour has passed")
  assert.equal((await new ProviderProfileCache(cachePath).catalog(account))?.savedAt, cacheNow)

  // Hosts share the file: each reads it again before it writes, and keeps what the other saved.
  const sharedPath = join(cacheDir, "shared.json")
  const left = new ProviderProfileCache(sharedPath)
  const right = new ProviderProfileCache(sharedPath)
  await left.get("codex:left:", "codex:left:/work")
  await right.get("codex:right:", "codex:right:/work")
  await left.put("codex:left:", "codex:left:/work", { ...listed, id: "codex" })
  await right.put("codex:right:", "codex:right:/work", { ...listed, id: "codex", models: [] })
  cacheNow += 1
  await left.put("codex:left:", "codex:left:/other", { ...listed, id: "codex", settings: { model: "model-one" } })
  const shared = new ProviderProfileCache(sharedPath)
  assert.deepEqual((await shared.catalog("codex:left:"))?.profile.models, listed.models, "two hosts sharing the file keep each other's entries")
  assert.deepEqual((await shared.catalog("codex:right:"))?.profile.models, [])
  assert.deepEqual((await right.catalog("codex:left:"))?.profile.models, listed.models, "and each learns the other's as it writes")

  // A cache written by an earlier build kept a whole profile per folder, and
  // by one whose profiles carried capability tags: both still load, the stale
  // tags are dropped, and the folders are folded into their account as it is
  // next saved. Fields this build does not name are written back.
  const olderPath = join(cacheDir, "older.json")
  await writeFile(olderPath, JSON.stringify({
    version: 3,
    later: { kept: true },
    entries: {
      "cursor:default:/work/old": { hash: "older", savedAt: 1, note: "kept" },
      "cursor:default:/work/older": { hash: "oldest", savedAt: 0 },
      "cursor:second:/work/old": { hash: "older", savedAt: 1, note: "kept" },
    },
    snapshots: {
      older: { ...listed, settings: { model: "model-one" }, capabilities: ["start", "resume-acp"] },
      oldest: { ...listed, models: [] },
    },
  }))
  const older = new ProviderProfileCache(olderPath)
  assert.deepEqual((await older.get(account, `${account}/work/old`))?.profile, { ...listed, settings: { model: "model-one" } })
  assert.deepEqual((await older.catalog(account))?.profile, listed, "an earlier build's newest folder is the account's list")
  await older.put(account, `${account}/work/new`, listed)
  const rewritten = z.object({ later: z.unknown(), entries: z.record(z.string(), z.unknown()), snapshots: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(await readFile(olderPath, "utf8")))
  assert.deepEqual(Object.keys(rewritten.entries).sort(), [account, "cursor:second:/work/old"], "the account's folders are folded into it; another account's stay")
  assert.deepEqual(rewritten.entries["cursor:second:/work/old"], { hash: "older", savedAt: 1, note: "kept" }, "an entry's unknown field is written back")
  assert.deepEqual(rewritten.later, { kept: true }, "and the file's")
  assert.equal(Object.keys(rewritten.snapshots).length, 2)
  clock.mock.restore()
} finally {
  await rm(cacheDir, { recursive: true, force: true })
}

const providers = providerHost.profiles.list().map((loader) => loader.provider)
assert.ok(providers.length > 0)
assert.equal(new Set(providers).size, providers.length)
// Supported families match their declarations. Cursor's runner is its SDK child in one-shot
// mode, so it has one transport and no ACP source. Cursor and Grok expose
// provider-owned sign-in.
assert.deepEqual(
  providerHost.nativeRunners.list().map((runner) => runner.provider),
  providerHost.harnesses
    .list()
    .filter((entry) => !entry.absent.nativeRunner)
    .map((entry) => entry.provider)
)
assert.equal(providerHost.liveDrivers.get("cursor")?.resume.kind, "native")
const cursorSteering = providerHost.harnesses.get("cursor")?.capabilities.steering
assert.ok(cursorSteering?.state === "implemented" && cursorSteering.lands === "interrupt", "the window learns where Cursor's steering lands from the driver")
assert.deepEqual(
  providerHost.connections.list().map((connection) => connection.provider),
  ["cursor", "grok"]
)
assert.deepEqual(
  providerHost.mcpSources.list().map((source) => source.provider),
  providerHost.harnesses
    .list()
    .filter((entry) => !entry.absent.mcp)
    .map((entry) => entry.provider)
)
assert.deepEqual(
  providerHost.skillSources.list().map((source) => source.provider),
  providerHost.harnesses
    .list()
    .filter((entry) => !entry.absent.skills)
    .map((entry) => entry.provider)
)
assert.deepEqual(
  providerHost.acpSources.list().map((source) => source.provider),
  ["grok", "devin"]
)
assert.equal(providerHost.liveDrivers.get("opencode")?.resume.kind, "native")
assert.equal(providerHost.liveDrivers.get("opencode")?.nativeAgents.kind, "observed")
assert.deepEqual(
  providerHost.processProbes.list().map((probe) => probe.provider),
  providerHost.harnesses
    .list()
    .filter((entry) => !entry.absent.processProbe)
    .map((entry) => entry.provider)
)
assert.equal(providerHost.nativeRunners.get("claude")?.fastMode, "supported")
assert.equal(providerHost.profiles.get("claude")?.transport, "sdk")
assert.equal(providerHost.liveDrivers.get("claude")?.steering.kind, "supported")
assert.equal(
  providerHost.liveDrivers.get("claude")?.compaction?.kind,
  "supported"
)
assert.equal(
  providerHost.liveDrivers.get("codex")?.compaction?.kind,
  "supported"
)
assert.equal(
  providerHost.liveDrivers.get("devin")?.compaction?.kind,
  "supported"
)
assert.equal(
  providerHost.liveDrivers.get("opencode")?.compaction?.kind,
  "supported"
)
assert.equal(
  providerHost.liveDrivers.get("grok")?.compaction?.kind,
  "supported"
)
assert.equal(
  providerHost.liveDrivers.get("cursor")?.compaction?.kind,
  "automatic"
)
assert.equal(providerHost.harnesses.get("cursor")?.capabilities.compaction.state, "default")
assert.deepEqual(
  providerHost.accountCapabilities
    .list()
    .map((capability) => [capability.provider, capability.mode]),
  [
    ["claude", "selectable"],
    ["codex", "selectable"],
    ["cursor", "selectable"],
    ["opencode", "observed"],
    ["grok", "selectable"],
    ["devin", "selectable"],
  ]
)
assert.equal(
  (
    await providerHost.accountCapabilities
      .get("cursor")
      ?.accountEnv("default", { PATH: "/bin" })
  )?.PATH,
  "/bin",
  "the harness's own login leaves its environment as it is"
)
const accountCapability: ProviderAccountCapability =
  providerHost.accountCapabilities.get("claude")!
assert.equal(accountCapability.mode, "selectable")

const claude = providerHost.nativeRunners.get("claude")!
assert.deepEqual(
  await claude.resume("session", "continue", {
    model: "opus",
    options: { effort: "high" },
  }),
  {
    command: claudeRuntime()?.executable ?? "claude",
    args: [
      "-p",
      "continue",
      "--resume",
      "session",
      "--dangerously-skip-permissions",
      "--model",
      "opus",
      "--effort",
      "high",
    ],
  }
)

const codex = providerHost.nativeRunners.get("codex")!
assert.deepEqual(
  await codex.resume("session", "continue", {
    model: "gpt-5",
    options: { effort: "high", serviceTier: "fast" },
  }),
  {
    command: "codex",
    args: [
      "exec",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-m",
      "gpt-5",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'service_tier="priority"',
      "resume",
      "session",
      "continue",
    ],
  }
)

const grok = providerHost.nativeRunners.get("grok")!
assert.deepEqual(
  await grok.resume("session", "continue", { options: { effort: "high" } }),
  {
    command: "grok",
    args: [
      "-p",
      "continue",
      "--resume",
      "session",
      "--always-approve",
      "--reasoning-effort",
      "high",
    ],
    env: { _GROK_CLAUDE_MARKER_OVERRIDE: "1" },
  }
)

const devin = providerHost.nativeRunners.get("devin")!
assert.deepEqual((await devin.fresh("start", { model: "adaptive" })).args, [
  "-p",
  "start",
  "--permission-mode",
  "smart",
  "--respect-workspace-trust",
  "false",
  "--model",
  "adaptive",
])

const openCode = providerHost.nativeRunners.get("opencode")!
// The runner's arguments, whatever is installed: it resolves an installation first, so a stand-in answers its version
// (a CI Mac has no OpenCode; this one passed only where someone had installed it).
const openCodeHome = await mkdtemp(join(tmpdir(), "mako-opencode-"))
const openCodeBin = join(openCodeHome, "opencode")
await writeFile(openCodeBin, `#!/bin/sh\necho "${OPENCODE_OLDEST}"\n`)
await chmod(openCodeBin, 0o755)
const openCodeWas = process.env.OPENCODE_BIN_PATH
process.env.OPENCODE_BIN_PATH = openCodeBin
const openCodeFresh = await Promise.resolve(openCode.fresh("start", { model: "openai/gpt" })).finally(() => {
  if (openCodeWas === undefined) delete process.env.OPENCODE_BIN_PATH
  else process.env.OPENCODE_BIN_PATH = openCodeWas
})
await rm(openCodeHome, { recursive: true, force: true })
assert.equal(openCodeFresh.args[0], "run")
assert.equal(openCodeFresh.args.at(-1), "start")
assert.ok(openCodeFresh.args.includes("openai/gpt"))

const grokAcp = await providerHost.acpSources.get("grok")!.launch({
  appPath: process.cwd(),
  execPath: process.execPath,
  cwd: process.cwd(),
  tuning: { options: { effort: "high" } },
})
assert.equal(providerHost.profiles.get("grok")?.label, "Grok")
assert.equal(grokAcp?.command, "grok")
assert.deepEqual(grokAcp?.args, [
  "agent",
  "--no-leader",
  "--reasoning-effort",
  "high",
  "stdio",
])
const grokEnv: NodeJS.ProcessEnv = {}
grokAcp?.configureEnvironment(grokEnv)
assert.equal(grokEnv.GROK_DISABLE_AUTOUPDATER, "1")

assert.equal(providerHost.acpSources.get("claude"), undefined)
assert.equal(providerHost.acpSources.get("opencode"), undefined)

const registry = new ProviderRegistry<NativeRunner>()
const runner: NativeRunner = {
  provider: "fixture",
  transport: "fixture-headless",
  launchCredentials: { kind: "unavailable", reason: "Fixture credentials" },
  available: () => true,
  fastMode: "supported",
  carries: [],
  resume: () => ({ command: "fixture", args: [] }),
  fresh: () => ({ command: "fixture", args: [] }),
  describe: () => ({}),
}
const dispose = registry.register(runner)
assert.equal(registry.get("fixture"), runner)
assert.throws(() => registry.register(runner), /already registered/)
dispose()
assert.equal(registry.get("fixture"), undefined)
dispose()

console.log("Provider composition and native runner checks passed")
