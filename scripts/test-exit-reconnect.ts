import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "../electron/live-conversations.ts"
import { withExecutionAdmission } from "../electron/providers/execution-admission.ts"
import { providerHost } from "../electron/providers/index.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.ts"

// A harness process that dies after accepting a turn, through the real session
// owner and real shared admission, for every registered harness and a future
// one: the turn is interrupted, the exited binding is cleaned up through its
// driver (letting go of its account), and the same native session reopens and
// continues once. Installed CLIs run the same case in
// `MAKO_WAKE_SCENARIO=exit-tool scripts/test-native-wake-acceptance.mjs`.
const root = await mkdtemp(join(tmpdir(), "mako-exit-reconnect-"))
async function until(label: string, check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await delay(5)
  }
}
try {
  const providers = [...providerHost.liveDrivers.list().map((driver) => driver.provider), "seventh-fixture"]
  const prototype = providerHost.liveDrivers.list()[0]!
  for (const provider of providers) {
    const log: string[] = []
    const emits = new Map<string, (event: LiveDriverEvent) => void>()
    const session = (id: string, patch: Partial<LiveSessionState> = {}): LiveSessionState => ({
      harness: provider, id, cwd: root, nativeId: "native-1", connection: "connected", status: "ready",
      modes: [], currentMode: null, configOptions: [], ...patch,
    })
    const driver: ProviderLiveDriver = {
      ...prototype,
      provider,
      available: () => true,
      async start(_cwd, options) {
        log.push(options.resume ? `start resume ${options.resume}` : "start")
        emits.set(options.conversationId, options.emit!)
        return session(options.conversationId)
      },
      async prompt(id, text, _attachments, _settings, dispatch) {
        log.push(`prompt ${text === "work" ? "work" : "continue"}`)
        const emit = emits.get(id)!
        dispatch.report({ kind: "accepted", source: "native-response" })
        emit({ type: "live-session", session: session(id, { status: "running" }) })
        const end = log.filter((entry) => entry.startsWith("prompt")).length === 1
          ? session(id, { status: "failed", connection: "disconnected", error: "exited on SIGKILL" })
          : session(id)
        setTimeout(() => emit({ type: "live-session", session: end }), 5)
      },
      async close() { log.push("close") },
    }
    let held = 0
    const guarded = withExecutionAdmission(driver, {
      resolve: async () => {
        held++
        return { env: {}, account: { name: "default" }, selection: { kind: "unavailable" }, hold: { provider, name: "default", release: () => { held-- } } }
      },
      assertCurrent: async () => {},
      principal: async () => undefined,
      mismatch: async (principal, expected) => new Error(`${principal} is not ${expected}`),
    })
    const owner = new LiveConversations({
      root: join(root, provider), appPath: root, driver: () => guarded, history: async () => null, emit: () => {},
      resumeVerdict: async () => ({ kind: "resumable", record: "unknown" }), autoContinueDelayMs: 1,
    })
    const id = randomUUID()
    try {
      await owner.start(provider, root, { conversationId: id })
      await until(`${provider}: ready`, () => owner.snapshot(id)?.session.status === "ready")
      owner.submit(id, randomUUID(), "work")
      await until(`${provider}: the continuation completes`, () => owner.snapshot(id)?.requests[1]?.status === "completed")
      const [killed, continued] = owner.snapshot(id)!.requests
      assert.equal(killed.status, "interrupted")
      assert.equal(killed.interruption?.reason, "provider-exited")
      assert.equal(continued.continues?.requestId, killed.id)
      assert.equal(continued.continues?.auto, true)
      assert.deepEqual(log, ["start", "prompt work", "close", "start resume native-1", "prompt continue"],
        `${provider}: the exited binding is cleaned up before the same native session reopens`)
      assert.equal(owner.snapshot(id)!.session.nativeId, "native-1")
      assert.equal(held, 1, `${provider}: the exited process let go of its account; only the reopened one holds it`)
    } finally {
      await owner.close(id).catch(() => {})
      await owner.stop()
    }
  }
  console.log(`Exit reconnect: ${providers.join(", ")} continue a turn their process died in, in the same native session, after the exited binding let go of its owner and account`)
} finally {
  await rm(root, { recursive: true, force: true })
}
