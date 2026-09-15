import { LiveComposerControls, NextSessionModePicker } from "./live-controls"
import { useComposerSettings } from "./use-composer-settings"
import { AgentPicker } from "@/components/composer/agent-picker"
import { ForeignEffortPicker } from "@/components/composer/foreign-effort"
import { ForeignModelPicker } from "@/components/composer/foreign-model"
import { activeAcp, activeLiveAcp, useAcp } from "@/state/acp"
import { useThreads } from "@/state/threads"
import { descriptorFor } from "@/state/descriptors"

const EMPTY_QUEUE: never[] = []

/** The selected provider answers the next turn in the current conversation. */
export function ComposerRouting() {
  const viewing = useThreads(
    (state) => state.opening?.ref ?? state.viewing?.ref
  )
  const harness = useThreads((state) => state.composerHarness)
  const activeHarness = useAcp((state) => activeAcp(state)?.harness)
  const liveReady = useAcp(
    (state) =>
      activeLiveAcp(state)?.session.status === "ready" &&
      activeLiveAcp(state)?.session.connection === "connected"
  )
  const canCompact = useThreads(
    (state) => descriptorFor(state, activeHarness)?.canCompact === true
  )
  const liveThreadPath = useAcp((state) => activeAcp(state)?.threadPath)
  const queued = useAcp((state) => activeAcp(state)?.queued ?? EMPTY_QUEUE)
  const settings = useComposerSettings()
  const liveOwnsComposer = Boolean(
    activeHarness && (!viewing || viewing.path === liveThreadPath)
  )
  const sourceHarness = liveOwnsComposer ? activeHarness : viewing?.harness
  const moving = Boolean(sourceHarness && harness !== sourceHarness)

  return (
    <>
      <AgentPicker />
      <ForeignModelPicker view={settings} />
      <ForeignEffortPicker view={settings} />
      {liveOwnsComposer && !moving ? (
        <LiveComposerControls
          canCompact={canCompact}
          compactEnabled={liveReady && queued.length === 0}
        />
      ) : (
        <NextSessionModePicker />
      )}
      {moving ? (
        <span className="animate-enter flex h-7 items-center gap-1 rounded-md bg-fill-selected px-2 text-label font-medium text-foreground">
          continues here on send
        </span>
      ) : null}
    </>
  )
}
