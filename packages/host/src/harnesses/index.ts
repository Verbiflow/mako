import { join } from "node:path"
import { makoRuntimeReadings } from "@mako/sessions/record-observed"
import { makoRecords } from "@mako/sessions/record-streams"
import type { MethodTable } from "../base/methods.js"
import type { HostJobs, JobDemand } from "../base/host-jobs.js"
import type { ProviderHost } from "./host.js"
import { describeHarnesses } from "./harness-descriptors.js"
import { describeConnection } from "./connection-capability.js"
import { toolHarnesses } from "./tool-harnesses.js"
import type { ToolHarnesses } from "../tools/index.js"
import { assessProviderResume } from "./provider-recovery.js"
import { RuntimeUpdates } from "./runtime-updates.js"
import { ReleaseTimelines } from "./release-timelines.js"
import { nativeHarnesses } from "./native-runner.js"
import { HarnessProfiles } from "./harness-profiles.js"
import { ProviderProfileCache } from "./provider-profile-cache.js"
import type { HarnessAccounts } from "./accounts.js"
import type { AccountHarness, AccountProvider } from "../contracts/accounts.js"
import { accountRemovalSessions, type AccountSessions } from "./account-removal-sessions.js"
import { AccountLogins } from "./account-login.js"
import type { ProviderConnectionAction } from "../contracts/provider-connection.js"
import type { ProviderBinding, ResumeVerdict } from "../contracts/conversation-control.js"
import type { ThreadCatalog } from "../threads/index.js"
import type { HostEvent } from "../contracts/host-events-boot.js"

export { createHarnessHost, detachedHarnessContext } from "./harness-host.js"
export type { HarnessContext, ProviderHost } from "./host.js"
export type { AccountLaunch, HarnessAccounts } from "./accounts.js"
export { ExecutionAccountChanged, ExecutionIdentityMismatch } from "./accounts.js"
export type { AccountHold } from "./account-holds.js"
export type { AccountSessions } from "./account-removal-sessions.js"
export { HarnessProfiles } from "./harness-profiles.js"
export { harnessLabel } from "./harness-descriptors.js"
export { CloudSignInSync, installCloudSignIns, type CloudSignInStore } from "./cloud-sign-ins.js"
export type { CloudSignInPlace } from "./cloud-sign-in.js"
export { resolveHarnessTuning } from "./harness-models.js"
export type { AdmittedLiveDriver, ConversationTools, DriverGoalCommand, DriverSideQuestion, GoalDelivery, GoalsCapability, ProviderLiveDriver, ReviewCapability, ReviewStart, SideQuestionsCapability } from "./live-driver.js"
export { resumes } from "./live-capabilities.js"
export { approvalAnswerDigest } from "./approval-evidence.js"
export { dropUncarried, nativeHarnesses, type NativeCommand, type NativeRunOptions, type NativeRunner } from "./native-runner.js"
export { nativeRecord } from "./native-source.js"
export { verifyRecoveredSession } from "./provider-recovery.js"
export { carriedUsage, departedBinding, restorableTotals, spendBetween } from "./session-usage.js"
export { threadHarnesses } from "./thread-harnesses.js"
export { usageHarnesses } from "./usage-harnesses.js"
export { liveToolEffects, type LiveToolEffects } from "./live-engine.js"
export type { PromptDispatch } from "./prompt-dispatch.js"

/** The six adapters as this host has them: their versions, accounts, and whether a session can resume. */
export interface Harnesses {
  /** What each installed harness can do, registered by its module. */
  host: ProviderHost
  /**
   * Runtime versions are a per-user fact, like the provider profiles beside
   * them: every host on this machine launches the same binaries.
   */
  updates: RuntimeUpdates
  /** Each harness's models and settings, discovered per account and workspace. */
  profiles: HarnessProfiles
  /** The accounts each harness runs on, their usage and what holds them. */
  accounts: HarnessAccounts
  logins: AccountLogins
  accountRemoval: ReturnType<typeof accountRemovalSessions>
  /** Whether a native session can be resumed live, or why not. */
  assessResume(binding: ProviderBinding): Promise<ResumeVerdict>
  /** The harnesses this machine can run, live or headless. */
  installed(): string[]
  /** Where each harness keeps its MCP servers, skills and native configuration. */
  tools: ToolHarnesses
}

export interface HarnessesDeps {
  host: ProviderHost
  appRoot: string
  catalog: ThreadCatalog
  /** The live conversations, made after the harnesses; an account's removal asks them only once one runs. */
  live(): AccountSessions | undefined
  emit(event: HostEvent): void
  jobs: HostJobs
  /** On while a window listens; limits spent elsewhere are read only then. */
  subscribed: JobDemand
}

export function openHarnesses({ host, appRoot, catalog, live, emit, jobs, subscribed }: HarnessesDeps): Harnesses {
  const profiles = new HarnessProfiles(host, new ProviderProfileCache())
  const updates = new RuntimeUpdates({
    sources: () => host.updateSources.list(),
    processes: host.discovery,
    path: makoRuntimeReadings(),
    emit: (state) => emit({ type: "runtime-updates", updates: state }),
    // A new binary lists new models: drop the catalog and discover again, so
    // the picker shows what the updated CLI offers without a restart.
    onRuntimeChanged: ({ provider }) => {
      void profiles.refresh(provider)
    },
  })
  // When each harness published its releases, for the record store's evidence pass: read hourly at most once a day, never waited on.
  const releases = new ReleaseTimelines({ evidence: join(makoRecords(), "evidence"), sources: () => host.updateSources.list() })
  jobs.every("release-timelines", 60 * 60_000, () => releases.refresh(), { firstAfterMs: 60_000 })
  const { accounts } = host
  accounts.usage.onChange((harness, name, usage) => emit({ type: "account-usage", harness, name, usage }))
  accounts.watchElsewhere(jobs, [subscribed])
  profiles.onProfile(({ profile, cwd }) => emit({ type: "harness-profile", profile, cwd }))
  return {
    host,
    updates,
    profiles,
    accounts,
    logins: new AccountLogins(accounts, jobs),
    accountRemoval: accountRemovalSessions(accounts, live, (harness, name, event) => emit({ type: "account-removal", harness, name, event })),
    async assessResume(binding) {
      // Closed native records may be relocated; neither path grants a reopen.
      const current = binding.nativeId
        ? catalog.nativePath({ harness: binding.provider, nativeId: binding.nativeId, nativePath: binding.path })
        : undefined
      const closed = [binding.path, current]
        .map((path) => path ? catalog.ref(path) : undefined)
        .find((ref) => ref?.harness === binding.provider && ref.resumeUnavailable)
      if (closed?.resumeUnavailable) return { kind: "closed", reason: closed.resumeUnavailable }
      return assessProviderResume(binding, host.liveDrivers.get(binding.provider))
    },
    installed: () => [
      ...new Set([
        ...nativeHarnesses(host.nativeRunners),
        ...host.liveDrivers
          .list()
          .filter((driver) => driver.available(appRoot))
          .map((driver) => driver.provider),
      ]),
    ],
    tools: toolHarnesses(host),
  }
}

export interface HarnessMethodsDeps {
  harnesses: Harnesses
  appRoot: string
  /** The folder of the tab in front, where a tuning asked without one is read. */
  workspace(): Promise<string>
  emit(event: HostEvent): void
}

/** Sign-ins, accounts, profiles and versions of every harness. */
export function declareHarnessMethods(methods: MethodTable, { harnesses, appRoot, workspace, emit }: HarnessMethodsDeps): void {
  const { host } = harnesses
  /* Provider transports with their own sign-in (Cursor's SDK). */
  const listConnections = (refresh = false) =>
    Promise.all(host.connections.list().map((capability) => describeConnection(capability, refresh)))
  methods.handle("mako:provider-connections", (refresh?: boolean) => listConnections(refresh === true))
  methods.handle("mako:provider-connection-action", async (provider: string, action: ProviderConnectionAction) => {
    const capability = host.connections.get(provider)
    if (!capability) throw new Error(`${provider} has no connection to manage`)
    if (action.kind !== "refresh") await capability.act(action)
    return describeConnection(capability, action.kind === "refresh")
  })
  for (const capability of host.connections.list()) {
    capability.onChange?.(() => {
      // The transport a new thread opens through changed, and with it the
      // models on offer: discovery runs again and every window hears both.
      void harnesses.profiles.get(capability.provider, true).catch(() => undefined)
      void listConnections().then((connections) => emit({ type: "provider-connections", connections }))
    })
  }
  /* Harness accounts: several logins per CLI, Orca-style isolated homes. */
  const { accounts, logins } = harnesses
  methods.handle("mako:accounts", () => accounts.catalog())
  methods.handle("mako:account-login-start", (harness: AccountHarness, renew?: string) => logins.start(harness, renew))
  methods.handle("mako:account-login-wait", (id: string) => logins.wait(id))
  methods.handle("mako:account-login-code", (id: string, code: string) => logins.submitCode(id, code))
  methods.handle("mako:account-login-cancel", (id: string) => logins.cancel(id))
  methods.handle("mako:account-capture", (harness: AccountHarness, name: string) => accounts.capture(harness, name))
  methods.handle("mako:account-select", (harness: AccountHarness, name: string | null) => accounts.select(harness, name))
  methods.handle("mako:account-remove", (harness: AccountHarness, name: string) => accounts.remove(harness, name))
  methods.handle("mako:account-removal-plan", (harness: AccountHarness, name: string) => harnesses.accountRemoval.plan(harness, name))
  methods.handle("mako:account-keep", (harness: AccountHarness, name: string) => accounts.keep(harness, name))
  methods.handle("mako:account-usage", (harness: AccountProvider, name: string) => accounts.usage.read(harness, name))
  methods.handle("mako:account-reset", (harness: AccountProvider, name: string, attempt: string) => accounts.usage.useResetCredit(harness, name, attempt))

  // The picker opens on what is known; each provider's discovery arrives as
  // its own event, so the slowest CLI no longer hides the rest.
  methods.handle("mako:harness-profiles", (force?: boolean) => force === true ? harnesses.profiles.all(true) : harnesses.profiles.now())
  methods.handle("mako:harness-availability", () => {
    const available = new Set(harnesses.installed())
    return Object.fromEntries(
      host.profiles.list().map((profile) => [profile.provider, available.has(profile.provider)])
    )
  })
  // What is known answers at once; a reading that is due runs behind it and
  // arrives as `runtime-updates`. `refresh` re-reads everything, registry included.
  methods.handle("mako:harness-updates", (refresh?: boolean) => harnesses.updates.read(refresh === true))
  methods.handle("mako:harness-update", (provider: string) => harnesses.updates.update(provider))
  methods.handle("mako:harness-install", (provider: string) => harnesses.updates.install(provider))
  methods.handle("mako:harness-descriptors", () =>
    describeHarnesses(host, {
      live: (provider) => host.liveDrivers.get(provider)?.available(appRoot) === true,
      resumable: new Set(nativeHarnesses(host.nativeRunners)),
    })
  )
  methods.handle("mako:harness-tuning", async (harness: string, cwd?: string, force?: boolean) =>
    harnesses.profiles.get(harness, force, cwd ?? (await workspace()))
  )
}
