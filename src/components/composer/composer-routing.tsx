import { LiveComposerControls, NextSessionModePicker } from "./live-controls"
import { useComposerSettings } from "./use-composer-settings"
import { WorkspaceChoice } from "./workspace-choice"
import { AgentModelPicker } from "@/components/composer/agent-model-picker"
import { useAcp } from "@/state/acp"
import { scopedAcp, useConversationScope } from "@/state/conversation-scope"
import { useThreads } from "@/state/threads"


/** The selected provider answers the next turn in the current conversation. */
export function ComposerRouting() {
  const scope = useConversationScope()
  const globalViewing = useThreads(
    (state) => state.opening?.ref ?? state.viewing?.ref
  )
  const viewing = scope ? (scope.kind === "history" ? scope.ref : undefined) : globalViewing
  const globalHarness = useThreads((state) => state.composerHarness)
  const activeHarness = useAcp((state) => scopedAcp(state, scope)?.harness)
  const liveThreadPath = useAcp((state) => scopedAcp(state, scope)?.threadPath)
  const settings = useComposerSettings()
  const harness = scope ? settings.target.harness : globalHarness
  const liveOwnsComposer = Boolean(
    activeHarness && (!viewing || viewing.path === liveThreadPath)
  )
  const sourceHarness = liveOwnsComposer ? activeHarness : viewing?.harness
  const moving = Boolean(sourceHarness && harness !== sourceHarness)

  return (
    <>
      <AgentModelPicker view={settings} />
      {liveOwnsComposer && !moving ? (
        <LiveComposerControls />
      ) : (
        <NextSessionModePicker />
      )}
      {scope ? null : <WorkspaceChoice />}
    </>
  )
}
