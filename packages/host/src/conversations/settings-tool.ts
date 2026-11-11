import { z } from "zod"
import { machineCall, NOT_THE_PERSON } from "../base/host-client.js"
import type { MethodTable } from "../base/methods.js"
import type { AccessTier } from "../contracts/access.js"
import type { AgentCaller } from "../contracts/agents.js"
import type { JsonValue } from "../contracts/json.js"
import { settingValue, type Setting } from "../contracts/agent-asks.js"
import { AFTER_ACT, type SettingsInput, type SettingsResult } from "../contracts/thread-tools.js"
import type { AgentAskGate } from "./agent-ask-gate.js"

export interface SettingsToolDeps {
  /** The conversation a Session's agent runs in here. */
  conversationOf(session: string): string | undefined
  tier(conversationId: string): AccessTier | undefined
  /** A host call through the table every client calls, decoded: each read and change as Settings makes it. */
  invoke(channel: string, args: unknown[]): Promise<JsonValue | undefined>
  gate: AgentAskGate
}

const HandOffSchema = z.object({ onSleep: z.boolean(), unavailable: z.string().optional() }).loose()
const ContinuingSchema = z.object({ continueAfterRestart: z.boolean() }).loose()
const OrderSchema = z.array(z.string())
const KeepAwakeSchema = z.object({ settings: z.object({ on: z.boolean(), lidClosed: z.boolean() }), unavailable: z.string().optional() }).loose()

/** The settings an agent may read and change for the person, each by the host calls Settings makes. Their own decisions (sign-ins, access, spend, rules for Fins) aren't here. */
export class SettingsTool {
  readonly #deps: SettingsToolDeps

  constructor(deps: SettingsToolDeps) {
    this.#deps = deps
  }

  async call(caller: AgentCaller, input: SettingsInput): Promise<SettingsResult> {
    if (input.action === "read") return this.#read().catch((error: Error) => ({ refused: "failed", why: error.message }))
    const own = caller.kind === "agent" ? this.#deps.conversationOf(caller.session) : undefined
    if (caller.kind === "agent" && !own) return { refused: "no-thread", why: "No conversation here has that Session. Call it from a Thread's mako tools, or its shell, where MAKO_SESSION_ID names it." }
    const parsed = input.setting ? settingValue(input.setting, input.value) : undefined
    if (!parsed) return { refused: "bad-value", why: "Name a setting and its value: hand-off-on-sleep, continue-after-restart, keep-awake and keep-awake-lid-closed take true or false, harness-order a list of harnesses, commit-model a model." }
    if (own && this.#deps.tier(own) !== "full") {
      const ask = this.#deps.gate.ask(own, { kind: "setting", setting: parsed })
      return { outcome: "asked", ask: ask.id, next: AFTER_ACT.asked }
    }
    return this.run(parsed).catch((error: Error) => ({ refused: "failed", why: error.message }))
  }

  /** The change as Settings makes it, read back: what's said is what the host kept. */
  async run(setting: Setting): Promise<Extract<SettingsResult, { outcome: "set" }>> {
    const { invoke } = this.#deps
    const set = { outcome: "set", setting: setting.name, value: setting.value } as const
    if (setting.name === "hand-off-on-sleep") {
      const kept = HandOffSchema.safeParse(await invoke("mako:handoff-settings-set", [setting.value])).data
      if (kept?.onSleep !== setting.value) throw new Error(kept?.unavailable ?? "Mako kept this setting as it was.")
      return { ...set, ...(kept.unavailable && { note: kept.unavailable }) }
    }
    if (setting.name === "continue-after-restart") {
      const kept = ContinuingSchema.safeParse(await invoke("mako:conversation-settings-set", [{ continueAfterRestart: setting.value }])).data
      if (kept?.continueAfterRestart !== setting.value) throw new Error("Mako kept this setting as it was.")
      return set
    }
    if (setting.name === "harness-order") {
      await invoke("mako:harness-order", [setting.value])
      const kept = OrderSchema.safeParse(await invoke("mako:harness-order-saved", [])).data
      if (JSON.stringify(kept) !== JSON.stringify([...new Set(setting.value)])) throw new Error("Mako kept the harness order as it was.")
      return set
    }
    if (setting.name === "keep-awake" || setting.name === "keep-awake-lid-closed") {
      const field = setting.name === "keep-awake" ? "on" : "lidClosed"
      const kept = KeepAwakeSchema.safeParse(await invoke("mako:keep-awake-set", [{ [field]: setting.value }])).data
      if (kept?.unavailable) throw new Error(kept.unavailable)
      if (kept?.settings[field] !== setting.value) throw new Error("Mako kept this setting as it was.")
      return set
    }
    // It refuses a model that isn't connected; what it saves it answers nothing about.
    await invoke("mako:utility-choice", ["commit", setting.value])
    return set
  }

  async #read(): Promise<SettingsResult> {
    const { invoke } = this.#deps
    const [handOff, conversations, order, awake] = await Promise.all([invoke("mako:handoff-settings", []), invoke("mako:conversation-settings", []), invoke("mako:harness-order-saved", []), invoke("mako:keep-awake", [])])
    const keepAwake = KeepAwakeSchema.safeParse(awake).data
    return { outcome: "read", settings: { handOff: handOff ?? null, conversations: conversations ?? null, harnessOrder: order ?? null, keepAwake: keepAwake ? { ...keepAwake.settings, ...(keepAwake.unavailable && { unavailable: keepAwake.unavailable }) } : null } }
  }

}

/** `mako:settings-act`. */
export function declareSettingsMethods(methods: MethodTable, tool: () => Pick<SettingsTool, "call"> | undefined): void {
  methods.handle("mako:settings-act", (caller: AgentCaller, input: SettingsInput) =>
    caller.kind === "person" && machineCall() ? { refused: "no-thread" as const, why: NOT_THE_PERSON } : tool()?.call(caller, input) ?? { refused: "unavailable", why: "This host has no settings to change." })
}
