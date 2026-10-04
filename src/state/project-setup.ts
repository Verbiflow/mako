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
import { signedInByOrder } from "@/state/default-agent"
import { currentHarnessOrder, useHarnessOrder } from "@/state/harness-order"
import { prefsStore, usePrefs, type Prefs } from "@/state/prefs"
import { providerStore, useProviders } from "@/state/providers"
import { actions, store } from "@/state/session"
import { threadAppStore, useThreadApp } from "@/state/thread-app"
import { threads } from "@/state/threads"
import { threadsStore, useThreads } from "@/state/thread-store"

/** Who sets a project up: the harness and the model it's on. */
export interface SetupAgent {
  harness: string
  model?: string
}

/**
 * Who sets a project up in a new Thread: the first signed-in harness in the
 * person's harness order, on its model for new conversations, which is the
 * one saved in Settings › Models or else Mako's default for it. The
 * composer's pick plays no part.
 */
export function setupAgent(
  profiles: Record<string, HarnessProfile>,
  providerSettings: Prefs["providerSettings"],
  order: readonly string[]
): SetupAgent | undefined {
  const harness = signedInByOrder(profiles, order)[0]
  if (!harness) return undefined
  const agent: SetupAgent = { harness }
  const model = harnessDefaults(harness, profiles[harness], providerSettings[harness]).model?.label
  if (model) agent.model = model
  return agent
}

export function useSetupAgent(): SetupAgent | undefined {
  const profiles = useProviders((state) => state.profiles)
  const providerSettings = usePrefs((state) => state.providerSettings)
  const order = useHarnessOrder()
  return setupAgent(profiles, providerSettings, order)
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

/**
 * Ask the focused Thread's own conversation to set the project up. A Thread
 * with none starts one here, which Mako started for the setup, so it is
 * recorded as a setup Thread; a Thread asked in place keeps what it was.
 */
export async function setUpInThisThread(cwd: string, project: string): Promise<boolean> {
  const to = recipient(threadsStore.get().viewing?.ref, activeAcp(acpStore.get()))
  if (to.kind === "reply") return threads.reply(to.ref, ENVIRONMENT_SETUP_PROMPT)
  if (to.kind === "live") return acp.send(ENVIRONMENT_SETUP_PROMPT)
  const agent = currentSetupAgent()
  if (!agent) return false
  return acp.startSetup(agent.harness, cwd, ENVIRONMENT_SETUP_PROMPT, setupTitle(project), false)
}

/** Start setting a project up at once: a new Thread in a worktree of its own, with the plain request as its first message. */
export async function startProjectSetup(root: string, project: string): Promise<void> {
  const agent = currentSetupAgent()
  if (!agent) return
  if (!(await actions.newConversationIn(root))) return
  await acp.startSetup(agent.harness, root, ENVIRONMENT_SETUP_PROMPT, setupTitle(project), true)
}

function setupTitle(project: string): string {
  return `Set up ${project}`
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
  const profiles = providerStore.get().profiles
  const agent = setupAgent(profiles, prefsStore.get().providerSettings, currentHarnessOrder(Object.keys(profiles)))
  if (!agent) toast("Sign in to a harness in Settings › Agents to set this project up")
  return agent
}
