import { toast } from "sonner"
import { ENVIRONMENT_SETUP_PROMPT } from "../../electron/contracts/thread-environments"
import type { ThreadAppView } from "../../electron/contracts/thread-app"
import { appSetupContext } from "@/lib/app-setup-context"
import type { AttachmentInput } from "@/lib/attachments"
import { harnessLabel } from "@/lib/harness-label"
import type { HarnessProfile, ThreadRef } from "@/lib/types"
import { acp } from "@/state/acp"
import { acpStore, activeAcp, useAcp, type AcpConversation } from "@/state/acp-state"
import { composerModelName, harnessDefaults, liveSettingsTarget, threadSettingsTarget } from "@/state/composer-settings"
import { firstRunAgent, isSignedIn } from "@/state/default-agent"
import { prefsStore, usePrefs, type Prefs } from "@/state/prefs"
import { providerStore, useProviders } from "@/state/providers"
import { actions, store } from "@/state/session"
import { threadAppStore, useThreadApp } from "@/state/thread-app"
import { threads } from "@/state/threads"
import { threadsStore, useThreads } from "@/state/thread-store"

/** Who sets a project up: the agent, the model it's on, and the agent it stands in for. */
export interface SetupAgent {
  harness: string
  model?: string
  /** The composer's agent, when it isn't signed in and this one sets it up instead. */
  standingInFor?: string
}

/**
 * Who sets a project up in a new Thread: what a new Thread starts on, the
 * agent the person last picked on its defaults for new conversations; before
 * any pick, or when the picked agent isn't signed in, the one a first run
 * would choose.
 */
export function setupAgent(
  profiles: Record<string, HarnessProfile>,
  providerSettings: Prefs["providerSettings"],
  picked: string | undefined,
  history: readonly ThreadRef[]
): SetupAgent | undefined {
  const harness = picked && isSignedIn(profiles[picked]) ? picked : firstRunAgent(profiles, history)
  if (!harness) return undefined
  const agent: SetupAgent = { harness }
  const model = harnessDefaults(harness, profiles[harness], providerSettings[harness]).model?.label
  if (model) agent.model = model
  if (picked && harness !== picked && profiles[picked]) agent.standingInFor = picked
  return agent
}

export function useSetupAgent(): SetupAgent | undefined {
  const profiles = useProviders((state) => state.profiles)
  const providerSettings = usePrefs((state) => state.providerSettings)
  const picked = usePrefs((state) => state.composerHarness)
  const history = useThreads((state) => state.threads)
  return setupAgent(profiles, providerSettings, picked, history)
}

export function setupAgentLabel(agent: SetupAgent): string {
  return agent.model ? `${harnessLabel(agent.harness)} · ${agent.model}` : harnessLabel(agent.harness)
}

/** Where a message sent from the focused Thread goes, as the composer routes it. */
type Recipient =
  | { kind: "reply"; ref: ThreadRef }
  | { kind: "live"; conversation: AcpConversation }
  | { kind: "new" }

function recipient(viewing: ThreadRef | undefined, live: AcpConversation | null): Recipient {
  if (viewing && viewing.path !== live?.threadPath)
    return viewing.archived || viewing.resumeUnavailable ? { kind: "new" } : { kind: "reply", ref: viewing }
  return live ? { kind: "live", conversation: live } : { kind: "new" }
}

/** The focused Thread's own agent and model, which a setup asked for there runs on. */
export function useThreadAgent(): SetupAgent | undefined {
  const viewing = useThreads((state) => state.viewing?.ref)
  const live = useAcp(activeAcp)
  const fresh = useSetupAgent()
  // The model is read from the workspace's profile, which can land after the menu opens.
  useProviders((state) => state.contexts)
  const to = recipient(viewing, live)
  if (to.kind === "new") return fresh
  const target = to.kind === "reply" ? threadSettingsTarget(to.ref) : liveSettingsTarget(to.conversation)
  const agent: SetupAgent = { harness: target.harness }
  const model = composerModelName(target)
  if (model) agent.model = model
  return agent
}

/** Ask the focused Thread's own conversation to set the project up; a Thread with none starts one here. */
export async function setUpInThisThread(cwd: string): Promise<boolean> {
  const to = recipient(threadsStore.get().viewing?.ref, activeAcp(acpStore.get()))
  if (to.kind === "reply") return threads.reply(to.ref, ENVIRONMENT_SETUP_PROMPT)
  if (to.kind === "live") return acp.send(ENVIRONMENT_SETUP_PROMPT)
  const agent = currentSetupAgent()
  if (!agent) return false
  return acp.startFresh(agent.harness, cwd, ENVIRONMENT_SETUP_PROMPT)
}

/** Start setting a project up at once: a new Thread in a worktree of its own, with the plain request as its first message. */
export async function startProjectSetup(root: string, project: string): Promise<void> {
  const agent = currentSetupAgent()
  if (!agent) return
  if (!(await actions.newConversationIn(root))) return
  await acp.startInWorktree(agent.harness, root, ENVIRONMENT_SETUP_PROMPT, `Set up ${project}`)
}

/** The app of the folder the composer sends to: its live conversation's, the open one's, or the workspace's. */
function composerAppView(byCwd: Record<string, ThreadAppView>): ThreadAppView | undefined {
  const folders = [activeAcp(acpStore.get())?.cwd, threadsStore.get().viewing?.ref.cwd, store.get().meta?.cwd]
  for (const folder of folders) if (folder && byCwd[folder]) return byCwd[folder]
  return undefined
}

export function useComposerAppView(): ThreadAppView | undefined {
  return useThreadApp((state) => composerAppView(state.byCwd))
}

/** The project whose app control was hidden, if it's the composer's. */
export function hiddenAppProject(): Extract<ThreadAppView, { kind: "none" }> | undefined {
  const { byCwd, hidden } = threadAppStore.get()
  const view = composerAppView(byCwd)
  return view?.kind === "none" && hidden.includes(view.root) ? view : undefined
}

/** The app control's request for the composer's folder, as the attachment the `@` menu adds. */
export function appSetupAttachment(): AttachmentInput | null {
  const context = appSetupContext(composerAppView(threadAppStore.get().byCwd))
  return context ? { file: new File([context.text], context.name, { type: "text/markdown" }), contextLabel: context.label } : null
}

function currentSetupAgent(): SetupAgent | undefined {
  const { providerSettings, composerHarness } = prefsStore.get()
  const agent = setupAgent(providerStore.get().profiles, providerSettings, composerHarness, threadsStore.get().threads)
  if (!agent) toast("Sign in to an agent in Settings to set this project up")
  return agent
}
