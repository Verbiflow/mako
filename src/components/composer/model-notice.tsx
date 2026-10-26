import { modelNoticeText } from "@/lib/model-notice"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/harness-meta"
import { useHarnessIdentity } from "@/lib/harness-label"
import { replaceUnusableModel } from "@/state/composer-settings"
import { useComposerSettings } from "./use-composer-settings"
import type { ComposerNotice } from "@/extend/notices"

/**
 * One line above the composer when the model chosen for the next message
 * can't start: the harness stopped offering it, or lists it and refuses it.
 * The message won't send on it, so the line says why before Send does, with
 * the model it was covering one click away. Silent otherwise.
 *
 * A notice producer (`registerNotice`).
 */
export function useModelChoiceNotice(): ComposerNotice | null {
  useHarnessIdentity()
  const view = useComposerSettings()
  const issue = view.resolved.issues.find((entry) => entry.kind === "model")
  if (!issue) return null
  const models = view.profile?.models ?? []
  const text = modelNoticeText(issue, harnessLabel(view.target.harness), models)
  const instead = issue.instead ? models.find((model) => model.id === issue.instead) : undefined

  return {
    id: "model-choice",
    tone: "caution",
    icon: <HarnessIcon harness={view.target.harness} />,
    title: text,
    actions: instead ? [{ label: `Use ${instead.label}`, primary: true, onClick: () => replaceUnusableModel(view.target, issue) }] : undefined,
    data: { "data-model-notice": issue.source },
  }
}
