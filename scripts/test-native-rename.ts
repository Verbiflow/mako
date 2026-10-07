import { registeredHarnessIds } from "./registered-harnesses.ts"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "../electron/live-conversations.ts"
import { NO_NATIVE_EXCLUSION } from "../electron/contracts/execution-context.ts"
import { NO_NATIVE_PROMPT_IDENTITY } from "../electron/contracts/native-prompt-identity.ts"
import { providerHost } from "../electron/providers/index.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.ts"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

/**
 * A live session that changes native ID (Claude's /clear) must not keep the
 * previous session's source: a binding pairing the new ID with the old record
 * would reopen the wrong conversation, or refuse to reopen at all. Uses each
 * registered driver's own source declaration, plus file and shared-database
 * stores for a provider not written yet.
 */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const sharedDatabase: ProviderLiveDriver["nativeSource"] = (path, nativeId) => {
  const split = path.lastIndexOf("#")
  return split > 0 && path.slice(split + 1) === nativeId ? { path: path.slice(0, split), record: nativeId } : undefined
}
const cases = [
  ...registeredHarnessIds().map((provider) => ({ provider, nativeSource: providerHost.liveDrivers.get(provider)?.nativeSource })),
  { provider: "seventh-file", nativeSource: undefined },
  { provider: "seventh-database", nativeSource: sharedDatabase },
]
for (const { provider, nativeSource } of cases) {
  const root = mkdtempSync(join(tmpdir(), "mako-rename-"))
  const database = provider === "seventh-database"
  const source = (nativeId: string) => database ? join(root, `sessions.db#${nativeId}`) : join(root, `${nativeId}.jsonl`)
  const catalog = new Map<string, string>()
  let emit: (event: LiveDriverEvent) => void = () => {}
  let state: LiveSessionState
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    resume: fixtureResume(),
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider,
    nativeSource,
    available: () => true,
    async start(cwd, options) {
      emit = options.emit ?? (() => {})
      state = { id: options.conversationId, nativeId: "first", nativePath: source("first"), harness: provider, cwd,
        status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }
      return state
    },
    async prompt() {},
    async permission() {},
    async cancel() {},
    close() {},
    async setMode() {},
  }
  const owner = new LiveConversations({
    root, appPath: root, driver: () => driver, history: async () => null, emit() {},
    nativePath: (session) => (session.nativeId && catalog.get(session.nativeId)) || undefined,
  })
  const binding = (id: string) => owner.snapshot(id)!.control!.bindings[0]!
  try {
    const id = randomUUID()
    await owner.start(provider, root, { conversationId: id })
    await tick()
    assert.equal(binding(id).path, source("first"))

    emit({ type: "live-session", session: { ...state!, nativeId: "second" } })
    assert.equal(binding(id).nativeId, "second", `${provider}: the binding follows the new native ID`)
    assert.equal(binding(id).path, undefined, `${provider}: the previous session's source is not kept for the new ID`)
    emit({ type: "live-session", session: { ...state!, nativeId: "second", nativePath: undefined } })
    assert.equal(binding(id).path, undefined, `${provider}: a later report without a source does not restore the old one`)

    catalog.set("second", source("second"))
    owner.discoverNativePaths()
    assert.equal(binding(id).path, source("second"), `${provider}: the catalog locates the new session while it stays open`)

    emit({ type: "live-session", session: { ...state!, nativeId: "third", nativePath: source("third") } })
    if (!nativeSource || database)
      assert.equal(binding(id).path, source("third"), `${provider}: a new ID reported with its own source is taken as is`)
    else
      assert.notEqual(binding(id).path, source("second"), `${provider}: never left on the previous session's source`)
  } finally {
    owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}
console.log("Native rename: six harnesses plus file and shared-database stores drop the previous source on a new native ID, and relocate through the catalog while open")
