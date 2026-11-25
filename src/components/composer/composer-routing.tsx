import type { Ref } from "react"
import { LiveComposerControls, NextSessionModePicker } from "./live-controls"
import { PlanToggle, type PlanHandle } from "./plan-toggle"
import { useComposerSettings } from "./use-composer-settings"
import { RunPlaceChoice } from "./run-place-choice"
import { WorkspaceChoice } from "./workspace-choice"
import { AgentModelPicker } from "@/components/composer/agent-model-picker"
import { useAcp } from "@/state/acp"
import { scopedAcp, useConversationScope } from "@/state/conversation-scope"
import { useThreads } from "@/state/threads"
import { settingsTargetKey } from "@/state/composer-settings"
import { setPendingPlan, usePlanChoice } from "@/state/plan-choice"

/**
 * The composer's control row: who answers the next message (harness, model and its reasoning) and whether it plans
 * first. Only what a person touches message to message; where and how the work runs is the status line under the box
 * (`ComposerPlace`).
 */
export function ComposerRouting({
  plan,
  onPlanning,
}: {
  plan?: Ref<PlanHandle>
  onPlanning?: (planning: boolean) => void
}) {
  const settings = useComposerSettings()
  return (
    <>
      <AgentModelPicker view={settings} />
      <PlanToggle view={settings} handle={plan} onPlanning={onPlanning} />
    </>
  )
}

/**
 * Where and how the next turn runs, for the status line under the composer: this Mac or the cloud, the project folder
 * or its own branch, the access it runs under, and the Thread's Fins and relations. Each is still the control it was.
 */
export function ComposerPlace() {
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
      {scope ? null : (
        <>
          <RunPlaceChoice />
          <WorkspaceChoice />
        </>
      )}
      {liveOwnsComposer && !moving ? (
        <LiveComposerControls />
      ) : (
        <NextSessionModePicker
          planned={plannedMode}
          onChoose={() => setPendingPlan(settings.target, null)}
        />
      )}
    </>
  )
}
