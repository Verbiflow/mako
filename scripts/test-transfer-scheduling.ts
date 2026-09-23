import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { mock } from "node:test"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveTransfers } from "../electron/live-transfers.js"
import type { LiveSessionState, LiveDriverEvent } from "../electron/shared.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import type { Resident } from "../electron/live-runtime.js"

// A microtask spin prevents in-process timeouts from firing. The parent owns
// the deadline and only kills this isolated fixture process on regression.
if (!process.argv.includes("--fixture")) {
  const root = mkdtempSync(join(tmpdir(), "mako-transfer-scheduling-"))
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--fixture", root],
    { stdio: "inherit" }
  )
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 20_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve)
      child.once("error", reject)
    })
    assert.equal(
      timedOut,
      false,
      "blocked provider switch starved the event loop; fixture killed after 20 seconds"
    )
    assert.equal(code, 0, "transfer scheduling fixture failed")
  } finally {
    clearTimeout(timer)
    rmSync(root, { recursive: true, force: true })
  }
} else {
  const root = process.argv.at(-1)!
  for (const provider of [
    "claude",
    "codex",
    "cursor",
    "grok",
    "devin",
    "opencode",
    "future",
  ]) {
    const sessions = new Map<string, LiveSessionState>()
    const emitters = new Map<string, (event: LiveDriverEvent) => void>()
    const sent: string[] = []
    const starts: string[] = []
    const id = randomUUID()
    let startCalls = 0
    let resident: Resident | undefined
    const originalStart = LiveTransfers.prototype.start
    const calls = mock.method(
      LiveTransfers.prototype,
      "start",
      function (this: LiveTransfers, value: Resident) {
        startCalls++
        resident = value
        return originalStart.call(this, value)
      }
    )
    function driver(name: string): ProviderLiveDriver {
      return {
        approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
        provider: name,
        canResume: false,
        available: () => true,
        async start(cwd, options) {
          starts.push(name)
          const state: LiveSessionState = {
            id: options.conversationId,
            nativeId: randomUUID(),
            harness: name,
            cwd,
            status: "ready",
            connection: "connected",
            modes: [],
            currentMode: null,
            configOptions: [],
          }
          sessions.set(state.id, state)
          if (options.emit) emitters.set(state.id, options.emit)
          return state
        },
        async prompt(bindingId, text) {
          sent.push(text)
          const state = sessions.get(bindingId)
          assert.ok(state)
          const running: LiveSessionState = { ...state, status: "running" }
          sessions.set(bindingId, running)
          emitters.get(bindingId)?.({ type: "live-session", session: running })
        },
        async permission() {},
        async cancel() {},
        async setMode() {},
        close() {},
      }
    }
    const drivers = new Map(
      [driver(provider), driver("destination")].map((item) => [
        item.provider,
        item,
      ])
    )
    const owner = new LiveConversations({
      root: join(root, provider),
      appPath: root,
      driver: (name) => drivers.get(name),
      history: async () => null,
      emit() {},
    })
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 100; i++) {
        if (check()) return
        await delay(10)
      }
      assert.fail("state transition did not wake the transfer")
    }
    try {
      await owner.start(provider, root, { conversationId: id })
      await until(() => owner.snapshot(id)?.session.connection === "connected")
      owner.submit(id, randomUUID(), "active turn")
      await until(() => sent.length === 1)
      console.log(`CHECK ${provider}: queue a switch behind active work`)
      const transferId = randomUUID()
      owner.transfer(id, {
        id: transferId,
        provider: "destination",
        text: "after current turn",
        attachments: [],
      })
      const cpuStart = process.cpuUsage()
      const timeStart = performance.now()
      await delay(100)
      const cpu = process.cpuUsage(cpuStart)
      assert.equal(
        startCalls,
        1,
        "blocked start must not schedule itself again"
      )
      assert.ok(resident)
      assert.equal(
        resident.transferOperation,
        undefined,
        "blocked transfer must not own an async operation"
      )
      assert.equal(
        owner.snapshot(id)?.control?.transfers.at(-1)?.state.kind,
        "queued"
      )
      assert.deepEqual(
        starts,
        [provider],
        "waiting cannot start the destination"
      )
      console.log(
        `WAIT ${provider}: wall=${(performance.now() - timeStart).toFixed(1)}ms cpu=${((cpu.user + cpu.system) / 1000).toFixed(1)}ms starts=${startCalls}`
      )
      const current = sessions.get(id)
      assert.ok(current)
      emitters.get(id)?.({
        type: "live-session",
        session: { ...current, status: "ready" },
      })
      await until(() => sent.length === 2)
      assert.deepEqual(starts, [provider, "destination"])
      assert.equal(
        sent.filter((text) => text.includes("after current turn")).length,
        1
      )
      assert.equal(
        owner.snapshot(id)?.control?.transfers.at(-1)?.state.kind,
        "accepted"
      )
      owner.transfer(id, {
        id: transferId,
        provider: "destination",
        text: "after current turn",
        attachments: [],
      })
      assert.equal(
        sent.length,
        2,
        "duplicate command returns its receipt without another send"
      )
      console.log(
        `PASS ${provider}: timer stays responsive; injected completion wakes exactly one switch`
      )
    } finally {
      calls.mock.restore()
      owner.stop()
    }
  }
}
