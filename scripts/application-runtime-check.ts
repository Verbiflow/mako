import assert from "node:assert/strict"
import { z } from "zod"
import { app } from "electron"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { LiveConversations } from "../electron/live-conversations.js"
import { NativeRequests } from "../electron/native-requests.js"
import { installApplicationIpc } from "../electron/ipc/application.js"
import { invokeHost } from "../electron/ipc/register.js"
import { startWebHost } from "../electron/web-host.js"
import {
  invokeRuntime,
  subscribeRuntime,
} from "../electron/runtime-connection.js"
import {
  LifecycleStateSchema,
  type LifecycleAction,
} from "../electron/contracts/app-lifecycle.js"
import type { LiveSessionState } from "../electron/shared.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"

async function checkRuntime() {
  app.setPath("userData", join(app.getAppPath(), "profile"))
  await app.whenReady()
  const root = app.getPath("userData")
  const states = new Map<string, LiveSessionState>()
  const releases = new Map<string, () => void>()
  const sent: string[] = []
  const completed: LifecycleAction[] = []
  const driver: ProviderLiveDriver = {
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    provider: "fixture",
    canResume: true,
    available: () => true,
    async start(cwd, options) {
      const state: LiveSessionState = {
        id: options.conversationId,
        nativeId: options.conversationId,
        harness: "fixture",
        cwd,
        status: "ready",
        connection: "connected",
        modes: [],
        currentMode: null,
        configOptions: [],
      }
      states.set(state.id, state)
      return state
    },
    async prompt(id, text) {
      const state = states.get(id)
      assert.ok(state)
      sent.push(text)
      live.observe({
        type: "live-session",
        session: { ...state, status: "running" },
      })
      await new Promise<void>((resolve) => releases.set(id, resolve))
    },
    async cancel(id) {
      releases.get(id)?.()
    },
    close(id) {
      releases.get(id)?.()
    },
    async permission() {},
    async setMode() {},
  }
  const live = new LiveConversations({
    root: join(root, "conversations"),
    appPath: root,
    driver: () => driver,
    history: async () => null,
    emit: () => {},
  })
  const native = new NativeRequests(join(root, "native"), {
    read: async () => null,
    running: () => false,
    execute: async () => {},
    changed: () => {},
    failed: (message) => {
      throw new Error(message)
    },
  })
  const socket = join(app.getAppPath(), "host.sock")
  const host = await startWebHost(
    socket,
    invokeHost,
    async () => new Response(null, { status: 404 })
  )
  const application = installApplicationIpc({
    live,
    native,
    clients: host.clients,
    emit: host.event,
    quitClient: () => {},
    finish: (action) => {
      completed.push(action)
    },
  })
  const one = randomUUID()
  const two = randomUUID()
  const notifications = new Map<string, string>()
  const unsubscribers = [one, two].map((client) =>
    subscribeRuntime(
      socket,
      client,
      (packet) => {
        if (packet.channel !== "event") return
        const parsed = z
          .object({ type: z.literal("app-shutdown"), requestId: z.string() })
          .safeParse(packet.payload)
        if (parsed.success) notifications.set(client, parsed.data.requestId)
      },
      () => {}
    )
  )
  const wait = async (test: () => boolean) => {
    const until = Date.now() + 5000
    while (!test()) {
      if (Date.now() > until)
        throw new Error("Runtime condition did not settle")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  try {
    await wait(() => host.clients().length === 2)
    const id = randomUUID()
    await live.start("fixture", root, { conversationId: id })
    live.submit(id, randomUUID(), "first")
    await wait(() => releases.has(id))
    const queued = randomUUID()
    live.submit(id, queued, "queued")
    const snapshot = LifecycleStateSchema.parse(
      await invokeRuntime(socket, one, "mako:lifecycle-state", [])
    )
    assert.equal(snapshot.work.length, 1)
    await invokeRuntime(socket, one, "mako:lifecycle-command", [
      { kind: "wait", action: "restart" },
    ])
    assert.deepEqual(completed, [])
    const second = LifecycleStateSchema.parse(
      await invokeRuntime(socket, two, "mako:lifecycle-state", [])
    )
    assert.equal(second.operation.kind, "waiting")
    await invokeRuntime(socket, two, "mako:lifecycle-command", [
      { kind: "cancel" },
    ])
    const closing = invokeRuntime(socket, one, "mako:lifecycle-command", [
      { kind: "stop", action: "quit", revision: snapshot.revision },
    ])
    await wait(() => notifications.size === 2)
    assert.throws(
      () => live.submit(id, randomUUID(), "must not send"),
      /preparing to close/
    )
    assert.equal(
      live.snapshot(id)?.requests.find((request) => request.id === queued)
        ?.status,
      "held"
    )
    assert.deepEqual(sent, ["first"])
    const late = randomUUID()
    const disconnectLate = subscribeRuntime(
      socket,
      late,
      () => {},
      () => {}
    )
    unsubscribers.push(disconnectLate)
    await wait(() => host.clients().length === 3)
    await invokeRuntime(socket, one, "mako:shutdown-ack", [
      notifications.get(one),
    ])
    assert.deepEqual(completed, [])
    await invokeRuntime(socket, two, "mako:shutdown-ack", [
      notifications.get(two),
    ])
    const refused = LifecycleStateSchema.parse(await closing)
    assert.equal(refused.operation.kind, "error")
    assert.deepEqual(completed, [])
    disconnectLate()
    await wait(() => host.clients().length === 2)
    notifications.clear()
    const retry = invokeRuntime(socket, one, "mako:lifecycle-command", [
      { kind: "wait", action: "quit" },
    ])
    await wait(() => notifications.size === 2)
    await invokeRuntime(socket, one, "mako:shutdown-ack", [
      notifications.get(one),
    ])
    await invokeRuntime(socket, two, "mako:shutdown-ack", [
      notifications.get(two),
    ])
    await retry
    assert.deepEqual(completed, ["quit"])
    console.log(
      "Real Electron host and private-socket clients: shared deferred operation, cross-window cancellation, exact-run stop, held queue, blocked new sends, and all-window shutdown acknowledgements passed"
    )
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    unsubscribers.forEach((off) => off())
    application.dispose()
    host.close()
    live.stop()
    native.stop()
    app.exit(process.exitCode === undefined ? 0 : Number(process.exitCode))
  }
}
void checkRuntime().catch((error) => {
  console.error(error)
  app.exit(1)
})
