import {
  codexExecutableCandidates,
  resolveCodexExecutable,
} from "../electron/providers/codex/executable.ts"
import assert from "node:assert/strict"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import { z } from "zod"
import { resolveAcpConfigValue } from "../electron/acp-config.ts"
import {
  environmentForExecutable,
  resolveExecutable,
} from "../electron/executable.ts"
import { ProviderActivityEngine } from "../electron/provider-activity-engine.ts"
import { ProviderProfileCache } from "../electron/provider-profile-cache.ts"
import {
  claudeProcessProbeFor,
  parseClaudeActiveSessions,
} from "../electron/providers/claude/process-probe.ts"
import { parseCodexOpenSessionPaths } from "../electron/providers/codex/process-probe.ts"
import { parseCursorOpenSessionPaths } from "../electron/providers/cursor/process-probe.ts"
import {
  grokProcessProbe,
  parseGrokActiveSessions,
} from "../electron/providers/grok/process-probe.ts"
import type { ProviderAccountCapability } from "../electron/providers/account-capability.ts"
import {
  processIdentityMatches,
  processStartMatches,
} from "../electron/providers/process-liveness.ts"
import type { ProviderProcessProbe } from "../electron/providers/process-probe.ts"
import { providerHost } from "../electron/providers/index.ts"
import type { NativeRunner } from "../electron/providers/native-runner.ts"
import { ProviderRegistry } from "../electron/providers/registry.ts"

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
const cachedProfile = {
  id: "cursor",
  label: "Cursor",
  available: true,
  transport: "acp",
  models: [],
  capabilities: ["models"],
} satisfies HarnessProfile
try {
  const firstCache = new ProviderProfileCache(cachePath)
  await firstCache.put("cursor:default", cachedProfile)
  await firstCache.put("cursor:other", cachedProfile)
  const restartedCache = new ProviderProfileCache(cachePath)
  assert.deepEqual(await restartedCache.get("cursor:default"), cachedProfile)
  const cacheFileSchema = z.object({
    snapshots: z.record(z.string(), z.unknown()),
  })
  const stored = cacheFileSchema.parse(
    JSON.parse(await readFile(cachePath, "utf8"))
  )
  assert.equal(Object.keys(stored.snapshots).length, 1)
} finally {
  await rm(cacheDir, { recursive: true, force: true })
}

const providers = providerHost.profiles.list().map((loader) => loader.provider)
assert.ok(providers.length > 0)
assert.equal(new Set(providers).size, providers.length)
// Cursor has one transport, the SDK: no headless CLI runner and no ACP
// source, and it is the one provider with a sign-in of its own.
assert.deepEqual(
  providerHost.nativeRunners.list().map((runner) => runner.provider),
  providers.filter((provider) => provider !== "cursor")
)
assert.equal(providerHost.liveDrivers.get("cursor")?.canResume, true)
assert.equal(providerHost.liveDrivers.get("cursor")?.steering, "interrupt")
assert.deepEqual(
  providerHost.connections.list().map((connection) => connection.provider),
  ["cursor"]
)
assert.deepEqual(
  providerHost.mcpSources.list().map((source) => source.provider),
  providers
)
assert.deepEqual(
  providerHost.skillSources.list().map((source) => source.provider),
  providers
)
assert.deepEqual(
  providerHost.acpSources.list().map((source) => source.provider),
  ["grok", "devin", "opencode"]
)
assert.deepEqual(
  providerHost.sessionEmitters.list().map((emitter) => emitter.provider),
  ["claude", "codex", "cursor", "grok"]
)
assert.deepEqual(
  providerHost.processProbes.list().map((probe) => probe.provider),
  ["claude", "codex", "cursor", "grok", "opencode"]
)
assert.equal(providerHost.nativeRunners.get("claude")?.fastMode, "supported")
assert.equal(providerHost.profiles.get("claude")?.transport, "sdk")
assert.ok(providerHost.liveDrivers.get("claude")?.steer)
assert.ok(providerHost.liveDrivers.get("claude")?.compact)
assert.equal(providerHost.liveDrivers.get("codex")?.compact, undefined, "Do not expose compaction until native history retention passes")
assert.deepEqual(
  providerHost.accountCapabilities
    .list()
    .map((capability) => [capability.provider, capability.mode]),
  [
    ["claude", "selectable"],
    ["codex", "selectable"],
    ["opencode", "observed"],
  ]
)
assert.equal(providerHost.accountCapabilities.get("cursor"), undefined)
const accountCapability: ProviderAccountCapability =
  providerHost.accountCapabilities.get("claude")!
assert.equal(accountCapability.mode, "selectable")

const claude = providerHost.nativeRunners.get("claude")!
assert.deepEqual(
  claude.resume("session", "continue", {
    model: "opus",
    options: { effort: "high" },
  }),
  {
    command: "claude",
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
  codex.resume("session", "continue", {
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
assert.deepEqual(grok.resume("session", "continue", { options: { effort: "high" } }), {
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
})

const devin = providerHost.nativeRunners.get("devin")!
assert.deepEqual(devin.fresh("start", { model: "adaptive" }).args, [
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
const openCodeFresh = openCode.fresh("start", { model: "openai/gpt" })
assert.equal(openCodeFresh.args[0], "run")
assert.equal(openCodeFresh.args.at(-1), "start")
assert.ok(openCodeFresh.args.includes("openai/gpt"))

const grokAcp = await providerHost.acpSources.get("grok")!.launch({
  appPath: process.cwd(),
  execPath: process.execPath,
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

const openCodeSource = providerHost.acpSources.get("opencode")!
if (openCodeSource.available(process.cwd())) {
  const openCodeAcp = await openCodeSource.launch({
    appPath: process.cwd(),
    execPath: process.execPath,
  })
  assert.deepEqual(openCodeAcp?.args, ["acp"])
}

const registry = new ProviderRegistry<NativeRunner>()
const runner: NativeRunner = {
  provider: "fixture",
  fastMode: "supported",
  resume: () => ({ command: "fixture", args: [] }),
  fresh: () => ({ command: "fixture", args: [] }),
}
const dispose = registry.register(runner)
assert.equal(registry.get("fixture"), runner)
assert.throws(() => registry.register(runner), /already registered/)
dispose()
assert.equal(registry.get("fixture"), undefined)
dispose()

console.log("Provider composition and native runner checks passed")
