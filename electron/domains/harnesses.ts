import { homedir } from "node:os"
import { join } from "node:path"
import type { MethodTable } from "@mako/host/base/methods"
import { providerHost } from "../providers/index.js"
import { describeHarnesses } from "../providers/harness-descriptors.js"
import { describeConnection } from "../providers/connection-capability.js"
import { toolHarnesses } from "../providers/tool-harnesses.js"
import type { ToolHarnesses } from "@mako/host/tools"
import { assessProviderResume } from "../provider-recovery.js"
import { RuntimeUpdates } from "../runtime-updates.js"
import { resumableHarnesses } from "../drivers.js"
import { harnessProfile, harnessProfiles, harnessProfilesNow, onHarnessProfile, refreshHarnessProfiles } from "../harnesses.js"
import { accountCatalog, accountUsage, captureAccount, keepAccount, onAccountUsage, removeAccount, selectAccount, useResetCredit } from "../accounts.js"
import { type AccountHarness, type AccountProvider } from "@mako/host/contracts/accounts"
import { accountRemovalSessions } from "../account-removal-sessions.js"
import { cancelAccountLogin, startAccountLogin, submitAccountLoginCode, waitAccountLogin } from "../account-login.js"
import type { ProviderConnectionAction } from "@mako/host/contracts/provider-connection"
import type { ProviderBinding, ResumeVerdict } from "@mako/host/contracts/conversation-control"
import type { ThreadCatalog } from "@mako/host/threads"
import type { LiveConversations } from "../live-conversations.js"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"

/** The six adapters as this host has them: their versions, accounts, and whether a session can resume. */
export interface Harnesses {
  /**
   * Runtime versions are a per-user fact, like the provider profiles beside
   * them: every host on this machine launches the same binaries.
   */
  updates: RuntimeUpdates
  accountRemoval: ReturnType<typeof accountRemovalSessions>
  /** Whether a native session can be resumed live, or why not. */
  assessResume(binding: ProviderBinding): Promise<ResumeVerdict>
  /** The harnesses this machine can run, live or headless. */
  installed(): string[]
  /** Where each harness keeps its MCP servers, skills and native configuration. */
  tools: ToolHarnesses
}

export interface HarnessesDeps {
  appRoot: string
  catalog: ThreadCatalog
  /** The live conversations, made after the harnesses; an account's removal asks them only once one runs. */
  live(): LiveConversations | undefined
  emit(event: HostEvent): void
}

export function openHarnesses({ appRoot, catalog, live, emit }: HarnessesDeps): Harnesses {
  const updates = new RuntimeUpdates({
    sources: () => providerHost.updateSources.list(),
    processes: providerHost.discovery,
    path: join(homedir(), ".mako", "runtime-updates.json"),
    emit: (state) => emit({ type: "runtime-updates", updates: state }),
    // A new binary lists new models: drop the catalog and discover again, so
    // the picker shows what the updated CLI offers without a restart.
    onRuntimeChanged: ({ provider }) => {
      void refreshHarnessProfiles(provider)
    },
  })
  onAccountUsage((harness, name, usage) => emit({ type: "account-usage", harness, name, usage }))
  onHarnessProfile(({ profile, cwd }) => emit({ type: "harness-profile", profile, cwd }))
  return {
    updates,
    accountRemoval: accountRemovalSessions(live, (harness, name, event) => emit({ type: "account-removal", harness, name, event })),
    async assessResume(binding) {
      // Closed native records may be relocated; neither path grants a reopen.
      const current = binding.nativeId
        ? catalog.nativePath({ harness: binding.provider, nativeId: binding.nativeId, nativePath: binding.path })
        : undefined
      const closed = [binding.path, current]
        .map((path) => path ? catalog.ref(path) : undefined)
        .find((ref) => ref?.harness === binding.provider && ref.resumeUnavailable)
      if (closed?.resumeUnavailable) return { kind: "closed", reason: closed.resumeUnavailable }
      return assessProviderResume(binding, providerHost.liveDrivers.get(binding.provider))
    },
    installed: () => [
      ...new Set([
        ...resumableHarnesses(),
        ...providerHost.liveDrivers
          .list()
          .filter((driver) => driver.available(appRoot))
          .map((driver) => driver.provider),
      ]),
    ],
    tools: toolHarnesses(providerHost),
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
  /* Provider transports with their own sign-in (Cursor's SDK). */
  const listConnections = (refresh = false) =>
    Promise.all(providerHost.connections.list().map((capability) => describeConnection(capability, refresh)))
  methods.handle("mako:provider-connections", (refresh?: boolean) => listConnections(refresh === true))
  methods.handle("mako:provider-connection-action", async (provider: string, action: ProviderConnectionAction) => {
    const capability = providerHost.connections.get(provider)
    if (!capability) throw new Error(`${provider} has no connection to manage`)
    if (action.kind !== "refresh") await capability.act(action)
    return describeConnection(capability, action.kind === "refresh")
  })
  for (const capability of providerHost.connections.list()) {
    capability.onChange?.(() => {
      // The transport a new thread opens through changed, and with it the
      // models on offer: discovery runs again and every window hears both.
      void harnessProfile(capability.provider, true).catch(() => undefined)
      void listConnections().then((connections) => emit({ type: "provider-connections", connections }))
    })
  }
  /* Harness accounts: several logins per CLI, Orca-style isolated homes. */
  methods.handle("mako:accounts", () => accountCatalog())
  methods.handle("mako:account-login-start", (harness: AccountHarness, renew?: string) => startAccountLogin(harness, renew))
  methods.handle("mako:account-login-wait", (id: string) => waitAccountLogin(id))
  methods.handle("mako:account-login-code", (id: string, code: string) => submitAccountLoginCode(id, code))
  methods.handle("mako:account-login-cancel", (id: string) => cancelAccountLogin(id))
  methods.handle("mako:account-capture", (harness: AccountHarness, name: string) => captureAccount(harness, name))
  methods.handle("mako:account-select", (harness: AccountHarness, name: string | null) => selectAccount(harness, name))
  methods.handle("mako:account-remove", (harness: AccountHarness, name: string) => removeAccount(harness, name))
  methods.handle("mako:account-removal-plan", (harness: AccountHarness, name: string) => harnesses.accountRemoval.plan(harness, name))
  methods.handle("mako:account-keep", (harness: AccountHarness, name: string) => keepAccount(harness, name))
  methods.handle("mako:account-usage", (harness: AccountProvider, name: string) => accountUsage(harness, name))
  methods.handle("mako:account-reset", (harness: AccountProvider, name: string, attempt: string) => useResetCredit(harness, name, attempt))

  // The picker opens on what is known; each provider's discovery arrives as
  // its own event, so the slowest CLI no longer hides the rest.
  methods.handle("mako:harness-profiles", (force?: boolean) => force === true ? harnessProfiles(true) : harnessProfilesNow())
  methods.handle("mako:harness-availability", () => {
    const available = new Set(harnesses.installed())
    return Object.fromEntries(
      providerHost.profiles.list().map((profile) => [profile.provider, available.has(profile.provider)])
    )
  })
  // What is known answers at once; a reading that is due runs behind it and
  // arrives as `runtime-updates`. `refresh` re-reads everything, registry included.
  methods.handle("mako:harness-updates", (refresh?: boolean) => harnesses.updates.read(refresh === true))
  methods.handle("mako:harness-update", (provider: string) => harnesses.updates.update(provider))
  methods.handle("mako:harness-install", (provider: string) => harnesses.updates.install(provider))
  methods.handle("mako:harness-descriptors", () =>
    describeHarnesses(providerHost, {
      live: (provider) => providerHost.liveDrivers.get(provider)?.available(appRoot) === true,
      resumable: new Set(resumableHarnesses()),
    })
  )
  methods.handle("mako:harness-tuning", async (harness: string, cwd?: string, force?: boolean) =>
    harnessProfile(harness, force, cwd ?? (await workspace()))
  )
}
