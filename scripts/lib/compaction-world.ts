import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { followHostLog } from "@mako/host/base/host-log"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { ProviderFailureError, providerTextEvidence } from "@mako/host/contracts/provider-failure"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { ProviderLiveDriver, ProviderStartOptions } from "@mako/host/harnesses/live-driver"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { LiveActionResult } from "@mako/host/contracts/live-actions"
import type { LiveDriverEvent, LiveStartOptions } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { fixtureResume, noCapabilities } from "../fixtures/driver-capabilities.ts"

/** A real journal, dispatcher and transfer owner with a synthetic native protocol; never invokes a model. */
export function compactionWorld(root: string, options: {
  id?: string; launch?: Pick<LiveStartOptions, "account" | "tuning" | "modeId">; saveAgainMs?: number; emit?(event: HostEvent): void; closing?(binding: string): Promise<void>; starting?(options: LiveStartOptions): Promise<void>
} = {}) {
  mkdirSync(root, { recursive: true })
  const id = options.id ?? randomUUID()
  const calls: { binding: string; action: string }[] = []
  const launches: ProviderStartOptions[] = []
  const prompts: { binding: string; text: string }[] = []
  const logs: string[] = []
  const events = new Map<string, (event: LiveDriverEvent) => void>()
  const native = new Map<string, string>()
  const configurations = new Map<string, ProviderStartOptions>()
  const control = { failPrompt: false, rejectPrompt: false }
  const unfollow = followHostLog(line => { if (line.level === "warn") logs.push(JSON.stringify(line)) })
  const state = (binding: string, status: LiveSessionState["status"] = "ready"): LiveSessionState => ({
    id: binding, nativeId: native.get(binding), nativePath: join(root, binding), harness: "compaction-fixture", cwd: root,
    status, connection: "connected", modes: [], currentMode: configurations.get(binding)?.modeId ?? null, configOptions: [], settings: configurations.get(binding)?.tuning ? { ...configurations.get(binding)!.tuning, options: configurations.get(binding)!.tuning?.options } : undefined,
  })
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    approvalEvidence: { kind: "submission-only", reason: "Scripted native fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Scripted native fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Scripted native fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION, nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Scripted native fixture", feedback: { kind: "next-message", reason: "Scripted native fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Scripted native fixture" },
    turnRecovery: { kind: "manual", reason: "Scripted native fixture" },
    resume: fixtureResume({ inspect: async () => ({ kind: "available", checkpoint: "scripted", strategy: "same-session" }), readTurn: async () => ({ kind: "unfinished" }) }),
    provider: "compaction-fixture", available: () => true,
    start: async (_cwd, launch) => {
      launches.push(launch)
      configurations.set(launch.conversationId, launch)
      await options.starting?.(launch)
      native.set(launch.conversationId, launch.resume ?? randomUUID())
      if (launch.emit) events.set(launch.conversationId, launch.emit)
      writeFileSync(join(root, launch.conversationId), "retained native fixture")
      return state(launch.conversationId)
    },
    prompt: async (binding, text, _attachments, _settings, delivery) => {
      if (control.rejectPrompt) {
        control.rejectPrompt = false
        delivery.report({ kind: "not-accepted", source: "preflight", reason: "Synthetic context refusal" })
        throw new ProviderFailureError("context window exceeded", providerTextEvidence("context window exceeded"))
      }
      prompts.push({ binding, text })
      delivery.report({ kind: "accepted", source: "native-echo" })
      events.get(binding)?.({ type: "live-session", session: { ...state(binding, "running"), nativeRunId: randomUUID() } })
      const error = control.failPrompt ? "context window exceeded" : undefined
      control.failPrompt = false
      events.get(binding)?.({ type: "live-session", session: { ...state(binding, error ? "failed" : "ready"), lastStop: error ? "failed" : "completed", error, failureEvidence: error ? providerTextEvidence(error) : undefined } })
    },
    compaction: { kind: "supported", start: async (binding, action) => {
      calls.push({ binding, action })
      events.get(binding)?.({ type: "live-session", session: state(binding, "running") })
    } },
    permission: async () => {}, cancel: async binding => { events.get(binding)?.({ type: "live-session", session: { ...state(binding), lastStop: "cancelled" } }) }, close: async binding => { await options.closing?.(binding) }, setMode: async () => {},
  }
  const owner = new LiveConversations({ appPath: root, root: join(root, "journals"), driver: () => driver,
    history: async () => null, saveAgainMs: options.saveAgainMs, emit: event => options.emit?.(event), resumeVerdict: async () => ({ kind: "resumable", record: "same" }) })
  const result = (call: typeof calls[number], outcome: LiveActionResult) => {
    if (outcome.kind !== "uncertain") events.get(call.binding)?.({ type: "live-session", session: {
      ...state(call.binding, outcome.kind === "failed" ? "failed" : "ready"), ...outcome.kind === "failed" && { error: outcome.reason },
    } })
    events.get(call.binding)?.({ type: "live-action-result", id: call.binding, actionId: call.action, result: outcome })
  }
  return { id, owner, calls, launches, prompts, control, logs, result, state, events,
    fail: (call: typeof calls[number]) => result(call, { kind: "failed", reason: "Synthetic summary failed" }),
    start: async () => {
      await owner.start("compaction-fixture", root, { ...options.launch, conversationId: id })
      for (const end = Date.now() + 2_000; owner.snapshot(id)?.session.connection !== "connected"; ) {
        if (Date.now() >= end) throw new Error("fixture launch did not become ready")
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      await new Promise(resolve => setImmediate(resolve))
    },
    close: async () => { unfollow(); await owner.stop() },
  }
}
export type CompactionWorld = ReturnType<typeof compactionWorld>
