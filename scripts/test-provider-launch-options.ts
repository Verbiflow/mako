import assert from "node:assert/strict"
import { mock } from "node:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { providerHost } from "../electron/providers/index"
import { hostCallInputs } from "../electron/contracts/host-call-inputs"
import { RuntimeCallSchema } from "../electron/contracts/runtime"
import { invokeRuntime } from "../electron/runtime-connection"
import { startWebHost } from "../electron/web-host"
import type { LiveSnapshot, LiveStartOptions } from "../electron/shared"

Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { acp } = await import("../src/state/acp")
const { beginStart, launch } = await import("../src/state/acp-start")
const { acpStore } = await import("../src/state/acp-state")
const { prefsStore } = await import("../src/state/prefs")
const { providerStore, providerProfileKey } =
  await import("../src/state/providers")
const { threadsStore } = await import("../src/state/thread-store")
installMockBridge()
const root = await mkdtemp(join(tmpdir(), "mako-launch-options-"))
const socket = join(root, "runtime.sock")
const client = randomUUID()
const snapshots = new Map<string, LiveSnapshot>()
const calls: {
  provider: string
  options: LiveStartOptions
  dispatched: LiveStartOptions
}[] = []
const accepted: LiveStartOptions[] = []
const host = await startWebHost(
  socket,
  async (channel, args) => {
    assert.equal(channel, "mako:live-start")
    const [provider, cwd, options] = hostCallInputs[channel].parse(args)
    accepted.push(options)
    const snapshot: LiveSnapshot = {
      session: {
        id: options.conversationId,
        harness: provider,
        cwd,
        status: "starting",
        connection: "starting",
        modes: [],
        currentMode: null,
        configOptions: [],
      },
      revision: 1,
      createdAt: 1,
      blocks: [],
      base: null,
      permissions: [],
      requests: options.initialRequest
        ? [{ ...options.initialRequest, status: "queued" }]
        : [],
    }
    snapshots.set(options.conversationId, snapshot)
    return JSON.stringify({ ok: true, value: snapshot })
  },
  async () => new Response("fixture")
)
const bridge = getMako()
const start = mock.method(
  bridge,
  "liveStart",
  async (...[provider, cwd, options]: Parameters<typeof bridge.liveStart>) => {
    const args = hostCallInputs["mako:live-start"].parse([
      provider,
      cwd,
      options,
    ])
    const envelope = {
      channel: "mako:live-start",
      args: args.map((value) => ({ kind: "value", value })),
    }
    assert.equal(
      RuntimeCallSchema.safeParse(envelope).success,
      false,
      "Actual launch objects reproduce the old pre-serialization failure"
    )
    const browserWire = RuntimeCallSchema.parse(
      JSON.parse(JSON.stringify(envelope))
    )
    const reply = await invokeRuntime(socket, client, "mako:live-start", args)
    const snapshot = snapshots.get(options.conversationId)
    const dispatched = accepted.at(-1)
    assert.ok(snapshot && dispatched)
    assert.deepEqual(reply, snapshot)
    assert.deepEqual(
      browserWire.args[2],
      { kind: "value", value: dispatched },
      "Desktop and browser serialization must agree"
    )
    calls.push({ provider, options, dispatched })
    return snapshot
  }
)
function last(provider: string) {
  const call = calls.at(-1)
  assert.ok(call)
  assert.equal(call.provider, provider)
  return call
}
const rows = []
try {
  for (const driver of providerHost.liveDrivers.list()) {
    const provider = driver.provider
    const profile = providerHost.profiles.get(provider)
    assert.ok(profile, `${provider} needs a registered launch profile`)
    const reset = () => {
      acpStore.set({ activeKey: null, conversations: {} })
      threadsStore.set({
        viewing: null,
        opening: null,
        composerHarness: provider,
      })
      prefsStore.set({
        providerModes: {},
        providerSettings: {},
        settingsOverrides: {},
      })
      providerStore.set({
        contexts: {
          [providerProfileKey(provider, root)]: {
            id: provider,
            label: profile.label,
            available: true,
            transport: profile.transport,
            capabilities: [],
            models: [],
          },
        },
      })
    }
    reset()
    assert.equal(await acp.startFresh(provider, root, "Fresh prompt"), true)
    let call = last(provider)
    for (const field of ["threadPath", "displayPrompt", "modeId"] as const) {
      assert.equal(Object.hasOwn(call.options, field), true)
      assert.equal(call.options[field], undefined)
      assert.equal(Object.hasOwn(call.dispatched, field), false)
    }
    assert.equal(call.dispatched.resume, undefined)
    assert.equal(call.dispatched.initialRequest?.text, "Fresh prompt")
    assert.deepEqual(call.dispatched.initialRequest?.attachments, [])
    const sourceId = acpStore.get().activeKey
    assert.ok(sourceId)
    const source = acpStore.get().conversations[sourceId]
    assert.ok(source?.kind === "live")
    const savedRequest = {
      id: randomUUID(), text: "Recover this saved message", status: "failed" as const,
      attachments: [{ name: "saved.txt", mimeType: "text/plain", size: 1, path: "/retained/saved.txt" }],
    }
    const failedSource = { ...source, requests: [savedRequest] }
    acpStore.set({ conversations: { ...acpStore.get().conversations, [sourceId]: failedSource } })
    assert.equal(await acp.recoverFresh(sourceId, savedRequest.id), true)
    assert.notEqual(last(provider).dispatched.conversationId, sourceId)
    assert.equal(last(provider).dispatched.resume, undefined)
    assert.equal(last(provider).dispatched.initialRequest?.text, savedRequest.text)
    assert.deepEqual(last(provider).dispatched.initialRequest?.attachments, savedRequest.attachments)
    assert.equal(acpStore.get().conversations[sourceId], failedSource, "fresh recovery preserves the original conversation")
    reset()
    const empty = beginStart({
      harness: provider,
      cwd: root,
      settingsTarget: { kind: "new", harness: provider, cwd: root },
      blocks: [],
      hiddenUserPrompt: null,
    })
    assert.equal(await launch(empty, {}), true)
    assert.equal(last(provider).dispatched.initialRequest, undefined)
    reset()
    prefsStore.set({ providerModes: { [provider]: "saved-fixture-mode" } })
    const configured = beginStart({
      harness: provider,
      cwd: root,
      blocks: [{ type: "user", text: "Configured prompt" }],
      hiddenUserPrompt: null,
    })
    const tuning = {
      model: "fixture-model",
      options: { fast: false, effort: "high" },
    }
    assert.equal(
      await launch(configured, { tuning }, "Configured prompt", [
        {
          name: "file.txt",
          mimeType: "text/plain",
          size: 0,
          path: "/retained/file.txt",
          data: undefined,
        },
      ]),
      true
    )
    call = last(provider)
    assert.equal(call.dispatched.modeId, "saved-fixture-mode")
    assert.deepEqual(call.dispatched.tuning, tuning)
    assert.equal(
      Object.hasOwn(call.dispatched.initialRequest!.attachments[0]!, "data"),
      false
    )
    reset()
    prefsStore.set({ providerModes: { [provider]: "saved-fixture-mode" } })
    const explicit = beginStart({
      harness: provider,
      cwd: root,
      blocks: [],
      hiddenUserPrompt: null,
    })
    assert.equal(
      await launch(explicit, { modeId: "explicit-fixture-mode", tuning }),
      true
    )
    assert.equal(last(provider).dispatched.modeId, "explicit-fixture-mode")
    reset()
    assert.equal(
      await acp.startFresh(
        provider,
        root,
        "Read retained context, then continue",
        [],
        "Continue visibly"
      ),
      true
    )
    call = last(provider)
    assert.equal(call.dispatched.displayPrompt, "Continue visibly")
    assert.equal(
      call.dispatched.initialRequest?.text,
      "Read retained context, then continue"
    )
    if (driver.canResume) {
      reset()
      const ref = {
        harness: provider,
        nativeId: "fixture-native-id",
        path: join(root, "native-session"),
        cwd: root,
        title: "Saved thread",
      }
      assert.equal(await acp.resumeAndSend(ref, "Resume prompt"), true)
      call = last(provider)
      assert.equal(call.dispatched.resume, ref.nativeId)
      assert.equal(call.dispatched.threadPath, ref.path)
      assert.equal(call.dispatched.initialRequest?.text, "Resume prompt")
    }
    rows.push({
      provider,
      transport: profile.transport,
      freshDefaults: "passed",
      noInitialPrompt: "passed",
      nestedSettingsAndAttachment: "passed",
      savedAndExplicitModeEncoding: "passed",
      displayPrompt: "passed",
      resumeEncoding: driver.canResume ? "passed" : "not advertised",
    })
  }
  assert.ok(rows.some((row) => row.provider === "devin"))
  console.log(
    JSON.stringify(
      {
        kind: "Production launch actions and both wire representations; provider execution is stubbed, not a CLI/authentication test",
        rows,
      },
      null,
      2
    )
  )
} finally {
  start.mock.restore()
  host.close()
  Reflect.deleteProperty(globalThis, "window")
  await rm(root, { recursive: true, force: true })
}
