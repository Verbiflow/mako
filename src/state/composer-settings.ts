import {
  modelByIdentity,
  migrateSettingsPreference,
  optionDefault,
  resolveSessionSettings,
  type SessionSettings,
  type SettingValue,
  type SettingsPreference,
  type SessionModel,
} from "@mako/sessions/settings"
import type { HarnessProfile, ThreadRef } from "@/lib/types"
import { prefsStore, setPref } from "@/state/prefs"
import { providerStore, providerProfileKey, providers } from "@/state/providers"
import { threadsStore } from "@/state/thread-store"
import {
  acpForThread,
  acpStore,
  activeAcp,
  type AcpConversation,
} from "@/state/acp-state"
import { store } from "@/state/session"

export type ComposerTarget = { harness: string; cwd: string } & (
  | { kind: "new" }
  | { kind: "thread"; path: string }
  | { kind: "live"; id: string }
)

export function settingsTargetKey(target: ComposerTarget): string {
  return JSON.stringify([
    target.harness,
    target.kind,
    target.kind === "thread"
      ? target.path
      : target.kind === "live"
        ? target.id
        : target.cwd,
  ])
}

export function threadSettingsTarget(ref: ThreadRef): ComposerTarget {
  return {
    kind: "thread",
    path: ref.path,
    harness: ref.harness,
    cwd: ref.cwd ?? "",
  }
}

export function liveSettingsTarget(
  conversation: AcpConversation
): ComposerTarget {
  return conversation.threadPath
    ? {
        kind: "thread",
        path: conversation.threadPath,
        harness: conversation.harness,
        cwd: conversation.cwd,
      }
    : {
        kind: "live",
        id: conversation.key,
        harness: conversation.harness,
        cwd: conversation.cwd,
      }
}

export function currentSettingsTarget(
  harness = threadsStore.get().composerHarness
): ComposerTarget {
  const state = threadsStore.get()
  const ref = state.opening?.ref ?? state.viewing?.ref
  const live = ref
    ? acpForThread(acpStore.get(), ref)
    : activeAcp(acpStore.get())
  return resolveSettingsTarget({
    harness,
    ref,
    live: live
      ? {
          id: live.key,
          harness: live.harness,
          cwd: live.cwd,
          path: live.threadPath,
          settingsTarget:
            live.kind === "starting" ? live.settingsTarget : undefined,
        }
      : undefined,
    workspace: store.get().meta?.cwd,
  })
}

export function resolveSettingsTarget(input: {
  harness: string
  ref?: ThreadRef
  live?: {
    id?: string
    harness?: string
    cwd?: string
    path?: string
    /** The target a starting conversation was sent with, until the provider reports its session. */
    settingsTarget?: ComposerTarget
  }
  workspace?: string
}): ComposerTarget {
  const { harness, ref, live, workspace } = input
  if (live?.harness === harness && live.id) {
    // A conversation that is still starting has no session settings of its
    // own. Resolving it as an existing session would drop the provider
    // default and the saved preference the send was built from, and the
    // model control would read "unavailable" until the provider answered.
    // The send target it carries is exactly what the user was shown.
    if (live.settingsTarget?.harness === harness) return live.settingsTarget
    return live.path
      ? { kind: "thread", path: live.path, harness, cwd: live.cwd ?? "" }
      : { kind: "live", id: live.id, harness, cwd: live.cwd ?? "" }
  }
  if (ref?.harness === harness) return threadSettingsTarget(ref)
  return { kind: "new", harness, cwd: ref?.cwd ?? live?.cwd ?? workspace ?? "" }
}

/**
 * What the model control says when nothing resolves. Only a failed profile is
 * "unavailable"; a session that has not reported its model yet is loading,
 * and a finished conversation without one simply never recorded it.
 */
export function composerModelLabel(input: {
  target: ComposerTarget
  profile?: HarnessProfile
  error?: string
  /** The session is starting or answering, so its report is still on the way. */
  reporting: boolean
}): string {
  const { profile } = input
  if (input.error) return "Model unavailable"
  if (!profile || profile.pending) return "Loading model…"
  if (!profile.available) return "Model unavailable"
  if (input.target.kind === "new") return "Choose a model"
  return input.reporting ? "Loading model…" : "Model not recorded"
}

export function settingsSession(
  target: ComposerTarget
): SessionSettings | undefined {
  if (target.kind === "new") return undefined
  const threads = threadsStore.get()
  const conversation =
    target.kind === "thread"
      ? acpForThread(acpStore.get(), { path: target.path })
      : acpStore.get().conversations[target.id]
  const ref =
    target.kind === "thread"
      ? threads.opening?.ref.path === target.path
        ? threads.opening.ref
        : threads.viewing?.ref.path === target.path
          ? threads.viewing.ref
          : threads.threads.find((entry) => entry.path === target.path)
      : conversation?.kind === "live"
        ? threads.threads.find(
            (entry) =>
              entry.harness === target.harness &&
              entry.nativeId === conversation.session.nativeId
          )
        : undefined
  return observedSessionSettings(
    ref,
    conversation?.kind === "live" ? conversation.session.settings : undefined,
    providerStore.get().contexts[providerProfileKey(target.harness, target.cwd)]
      ?.models
  )
}

/** Native observations fill gaps only while both snapshots name the same model. */
export function observedSessionSettings(
  ref: Pick<ThreadRef, "model" | "settings"> | undefined,
  live: SessionSettings | undefined,
  models: readonly SessionModel[] = []
): SessionSettings {
  const native = ref?.settings ?? (ref?.model ? { model: ref.model } : {})
  if (!live) return native
  const liveModel = modelByIdentity(models, live.model)?.id ?? live.model
  const nativeModel = modelByIdentity(models, native.model)?.id ?? native.model
  if (liveModel && nativeModel && liveModel !== nativeModel) return live
  return { ...native, ...live, options: { ...native.options, ...live.options } }
}

export function settingsConversation(
  target: ComposerTarget
): AcpConversation | undefined {
  if (target.kind === "new") return undefined
  return target.kind === "live"
    ? acpStore.get().conversations[target.id]
    : (acpForThread(acpStore.get(), { path: target.path }) ?? undefined)
}

interface ComposerSettingsInput {
  target: ComposerTarget
  profile?: HarnessProfile
  overrides?: SessionSettings
  preference?: SettingsPreference
  session?: SessionSettings
  live?: { options?: HarnessProfile["models"][number]["options"] }
}

/** Both display and dispatch consume the same live capabilities and precedence. */
export function resolveComposerSettingsInput(input: ComposerSettingsInput) {
  const { target, profile, session, live } = input
  const models: SessionModel[] = (profile?.models ?? []).map((model) => {
    if (!live || profile?.transport !== "acp") return model
    // The running session reports which of the current model's options it
    // can change; one it does not report is fixed for this session. Another
    // model's options are not fixed: choosing that model switches the
    // session to it and its options are applied with the switch, so they
    // stay editable and the catalog describes them until the provider
    // reports the new model's own.
    const sameModel =
      modelByIdentity(profile.models, session?.model)?.id === model.id
    if (!sameModel) return model
    const options = model.options.map((option) => {
      const reported = live.options?.find((entry) => entry.id === option.id)
      if (reported)
        return {
          ...reported,
          role: reported.role ?? option.role,
          change: undefined,
        }
      return {
        ...option,
        disabledReason: `${option.label} cannot be changed in this running session.`,
      }
    })
    return { ...model, options }
  })
  const resolved = resolveSessionSettings({
    models,
    context: target.kind === "new" ? "new" : "existing",
    phase: live ? "turn" : "launch",
    overrides: input.overrides,
    preference: migrateSettingsPreference(input.preference, models),
    defaults: profile?.settings,
    session,
  })
  const model = modelByIdentity(models, resolved.settings.model)
  return { resolved, model, options: model?.options ?? [] }
}

function composerSettingsInput(target: ComposerTarget, profile?: HarnessProfile) {
  const prefs = prefsStore.get()
  const conversation = settingsConversation(target)
  return resolveComposerSettingsInput({
    target,
    profile:
      profile ??
      providerStore.get().contexts[
        providerProfileKey(target.harness, target.cwd)
      ],
    overrides: prefs.settingsOverrides[settingsTargetKey(target)],
    preference: prefs.providerSettings[target.harness],
    session: settingsSession(target),
    live:
      conversation?.kind === "live"
        ? { options: conversation.session.configOptions }
        : undefined,
  })
}

export function resolveComposerSettings(
  target: ComposerTarget,
  profile?: HarnessProfile
) {
  return composerSettingsInput(target, profile).resolved
}

/** Snapshot the user's intent before awaiting discovery. */
export async function settingsForSend(
  target: ComposerTarget
): Promise<SessionSettings> {
  const prefs = prefsStore.get()
  const overrides = prefs.settingsOverrides[settingsTargetKey(target)]
  const session = settingsSession(target)
  const conversation = settingsConversation(target)
  const live =
    conversation?.kind === "live"
      ? { options: conversation.session.configOptions }
      : undefined
  const cached =
    providerStore.get().contexts[providerProfileKey(target.harness, target.cwd)]
  if (!cached?.available || cached.configurationError) {
    const discovery = providers.load(target.harness, false, target.cwd)
    if (
      target.kind === "new" &&
      prefs.providerSettings[target.harness]?.source === "legacy"
    )
      await discovery
    else void discovery.catch(() => {})
  }
  const profile =
    providerStore.get().contexts[providerProfileKey(target.harness, target.cwd)]
  const { resolved } = resolveComposerSettingsInput({
    target,
    profile,
    overrides,
    session,
    live,
    preference: prefs.providerSettings[target.harness],
  })
  if (resolved.issues.length)
    throw new Error(resolved.issues.map((issue) => issue.message).join(" "))
  // Access is `modeId` / `currentMode`, never a provider config option. Copying
  // it into `options.mode` sent Cursor `access:full` where it only accepts
  // agent/plan/ask, so the turn never started.
  return resolved.settings
}

function saveOverrides(
  target: ComposerTarget,
  settings: SessionSettings
): void {
  setPref("settingsOverrides", {
    ...prefsStore.get().settingsOverrides,
    [settingsTargetKey(target)]: settings,
  })
  if (target.kind === "new") {
    setPref("providerSettings", {
      ...prefsStore.get().providerSettings,
      [target.harness]: { source: "saved", settings },
    })
  }
}

export function chooseComposerModel(
  target: ComposerTarget,
  model: string
): void {
  saveOverrides(target, { model })
}

export function chooseComposerOption(
  target: ComposerTarget,
  id: string,
  value: SettingValue
): void {
  const key = settingsTargetKey(target)
  const previous = prefsStore.get().settingsOverrides[key] ?? {}
  // Keep the effective model with an option edit so changing threads cannot rebind it.
  const model = resolveComposerSettings(target).settings.model
  saveOverrides(target, {
    ...previous,
    model,
    options: { ...previous.options, [id]: value },
  })
}

/**
 * Walk the provider's own values for a role — `reasoning` for effort, `speed`
 * for the fast lane — and land on the next one. Options the provider did not
 * report, or reports as fixed for this session, are not cycled.
 */
export function cycleComposerRole(role: "reasoning" | "speed"): string | null {
  const target = currentSettingsTarget()
  const { options, resolved } = composerSettingsInput(target)
  const option = options.find(
    (entry) => entry.role === role && entry.disabledReason === undefined
  )
  if (!option) return null
  const current =
    resolved.settings.options?.[option.id] ?? optionDefault(option)
  if (option.kind === "boolean") {
    chooseComposerOption(target, option.id, current !== true)
    return current !== true ? "on" : "off"
  }
  const values = option.values.map((choice) => choice.value)
  if (values.length === 0) return null
  // Select values are strings; a boolean current (a misplaced speed value)
  // stringifies to "true"/"false", which is what providers like Codex use.
  const index = values.indexOf(
    current === undefined ? "" : String(current)
  )
  const next = values[(index + 1) % values.length]!
  chooseComposerOption(target, option.id, next)
  return (
    option.values.find((choice) => choice.value === next)?.label ?? next
  )
}

export function resetComposerSettings(target: ComposerTarget): void {
  const overrides = { ...prefsStore.get().settingsOverrides }
  delete overrides[settingsTargetKey(target)]
  setPref("settingsOverrides", overrides)
  if (target.kind === "new") {
    const preferences = { ...prefsStore.get().providerSettings }
    delete preferences[target.harness]
    setPref("providerSettings", preferences)
  }
}

/** Remove only acknowledged edits. A later edit remains pending. */
export function acknowledgeComposerSettings(
  conversation: AcpConversation
): void {
  if (conversation.kind !== "live" || !conversation.session.settings) return
  const target = liveSettingsTarget(conversation)
  const key = settingsTargetKey(target)
  const pending = prefsStore.get().settingsOverrides[key]
  if (!pending) return
  const observed = conversation.session.settings
  const models =
    providerStore.get().contexts[providerProfileKey(target.harness, target.cwd)]
      ?.models ?? []
  const pendingModel = modelByIdentity(models, pending.model)
  const sameModel =
    pending.model === observed.model ||
    Boolean(
      pendingModel &&
      pendingModel.id === modelByIdentity(models, observed.model)?.id
    )
  if (pending.model && !sameModel) return
  if (
    Object.entries(pending.options ?? {}).some(
      ([id, value]) => observed.options?.[id] !== value
    )
  )
    return
  const overrides = { ...prefsStore.get().settingsOverrides }
  delete overrides[key]
  setPref("settingsOverrides", overrides)
}
