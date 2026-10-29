import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { z } from "zod"
import { app } from "electron"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { NativeRequests } from "@mako/host/conversations/native-requests"
import { declareApplicationMethods, Updates } from "@mako/host/application"
import { processHostEnvironment } from "@mako/host/base/host-environment"
import { CrashReports } from "@mako/host/base/crash"
import { HostMethods } from "@mako/host/transport/methods"
import { Admission } from "@mako/host/base/admission"
import { HostJobs } from "@mako/host/base/host-jobs"
import { unwatchedWork } from "@mako/host/base/event-loop"
import { startWebHost } from "@mako/host/transport/server"
import {
  invokeRuntime,
  subscribeRuntime,
} from "@mako/host/transport/connection"
import {
  LifecycleStateSchema,
  type LifecycleAction,
} from "@mako/host/contracts/app-lifecycle"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const gitRunner = new Git()

async function checkRuntime() {
  app.setPath("userData", join(app.getAppPath(), "profile"))
  await app.whenReady()
  const root = app.getPath("userData")
  const states = new Map<string, LiveSessionState>()
  const releases = new Map<string, () => void>()
  const sent: string[] = []
  const completed: LifecycleAction[] = []
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    resume: fixtureResume(),
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider: "fixture",
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
  const admission = new Admission()
  const live = new LiveConversations({
    root: join(root, "conversations"),
    appPath: root,
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    admission,
  })
  const native = new NativeRequests(join(root, "native"), {
    read: async () => null,
    running: () => false,
    execute: async () => {},
    changed: () => {},
    failed: (message) => {
      throw new Error(message)
    },
    admission,
  })
  const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
  const socket = join(app.getAppPath(), "host.sock")
  const jobs = new HostJobs()
  const subscribed = jobs.demand("a client is subscribed")
  const host = await startWebHost(
    socket,
    (channel, args, client, history, correlationId) => methods.invoke(channel, args, client, history, correlationId),
    async () => new Response(null, { status: 404 }),
    undefined, undefined, undefined, undefined, undefined,
    jobs,
    subscribed
  )
  const updates = new Updates({ git: gitRunner,
    environment: processHostEnvironment(),
    emit: () => {},
    desktop: { state: () => undefined, check: () => Promise.reject(new Error("No desktop updater here")), install: async () => {} },
  })
  const application = declareApplicationMethods(methods, {
    live,
    native,
    nativeRuns: { lifecycleWork: () => [], abort: () => {} },
    wake: { notify: () => {}, stop: () => {} },
    leaving: () => {},
    jobs,
    subscribed,
    admission,
    updates,
    clients: host.clients,
    emit: host.event,
    finish: (action) => {
      completed.push(action)
    },
    crashes: new CrashReports({ directory: join(root, "crashes"), version: app.getVersion() }),
    logPath: join(root, "logs", "host.log"),
  })
  const one = randomUUID()
  const two = randomUUID()
  const notifications = new Map<string, string>()
  const unsubscribers = [one, two].map((client) =>
    subscribeRuntime(
      socket,
      client,
      (packet) => {
        if (packet.channel !== "event" || packet.type !== "app-shutdown") return
        const parsed = z
          .object({ type: z.literal("app-shutdown"), requestId: z.string() })
          .safeParse(JSON.parse(packet.payload))
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
