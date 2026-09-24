import { LiveComposerControls, NextSessionModePicker } from "./live-controls"
import { useComposerSettings } from "./use-composer-settings"
import { AgentModelPicker } from "@/components/composer/agent-model-picker"
import { activeAcp, useAcp } from "@/state/acp"
import { useThreads } from "@/state/threads"


/** The selected provider answers the next turn in the current conversation. */
export function ComposerRouting() {
  const viewing = useThreads(
    (state) => state.opening?.ref ?? state.viewing?.ref
  )
  const harness = useThreads((state) => state.composerHarness)
  const activeHarness = useAcp((state) => activeAcp(state)?.harness)
  const liveThreadPath = useAcp((state) => activeAcp(state)?.threadPath)
  const settings = useComposerSettings()
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
    </>
  )
}
