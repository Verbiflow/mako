import { modelNoticeText } from "@/lib/model-notice"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/harness-meta"
import { useHarnessIdentity } from "@/lib/harness-label"
import { replaceUnusableModel } from "@/state/composer-settings"
import { useComposerSettings } from "./use-composer-settings"

/**
 * One line above the composer when the model chosen for the next message
 * can't start: the harness stopped offering it, or lists it and refuses it.
 * The message won't send on it, so the line says why before Send does, with
 * the model it was covering one click away. Silent otherwise.
 *
 * Registered on `composer.above`.
 */
export function ModelChoiceNotice() {
  useHarnessIdentity()
  const view = useComposerSettings()
  const issue = view.resolved.issues.find((entry) => entry.kind === "model")
  if (!issue) return null
  const models = view.profile?.models ?? []
  const text = modelNoticeText(issue, harnessLabel(view.target.harness), models)
  const instead = issue.instead ? models.find((model) => model.id === issue.instead) : undefined

  return (
    <div
      role="status"
      data-model-notice={issue.source}
      className="mb-1.5 flex items-center gap-2 rounded-md bg-raised px-2 py-1 text-ui text-caution"
    >
      <HarnessIcon harness={view.target.harness} className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={text}>{text}</span>
      {instead ? (
        <button
          type="button"
          onClick={() => replaceUnusableModel(view.target, issue)}
          className="pressable shrink-0 rounded px-1.5 py-0.5 text-label font-medium text-foreground hover:bg-fill-hover"
        >
          Use {instead.label}
        </button>
      ) : null}
    </div>
  )
}
