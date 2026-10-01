import type { Ref } from "react"
import { LiveComposerControls, NextSessionModePicker } from "./live-controls"
import { PlanToggle, type PlanHandle } from "./plan-toggle"
import { useComposerSettings } from "./use-composer-settings"
import { WorkspaceChoice } from "./workspace-choice"
import { AgentModelPicker } from "@/components/composer/agent-model-picker"
import { useAcp } from "@/state/acp"
import { scopedAcp, useConversationScope } from "@/state/conversation-scope"
import { useThreads } from "@/state/threads"
import { settingsTargetKey } from "@/state/composer-settings"
import { setPendingPlan, usePlanChoice } from "@/state/plan-choice"


/** The selected provider answers the next turn in the current conversation. */
export function ComposerRouting({
  plan,
  onPlanning,
}: {
  plan?: Ref<PlanHandle>
  onPlanning?: (planning: boolean) => void
}) {
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
  // A plan chosen for the next session by mode is the level it starts at.
  const plannedMode = usePlanChoice((state) => {
    const plan = state.pending[settingsTargetKey(settings.target)]
    return plan?.kind === "mode" ? plan.mode : undefined
  })

  return (
    <>
      <AgentModelPicker view={settings} />
      <PlanToggle view={settings} handle={plan} onPlanning={onPlanning} />
      {liveOwnsComposer && !moving ? (
        <LiveComposerControls />
      ) : (
        <NextSessionModePicker
          planned={plannedMode}
          onChoose={() => setPendingPlan(settings.target, null)}
        />
      )}
      {scope ? null : <WorkspaceChoice />}
    </>
  )
}
