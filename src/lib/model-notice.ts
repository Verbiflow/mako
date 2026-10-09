import { modelByIdentity, type ModelIssue, type SessionModel } from "@mako/sessions/settings"

export function modelNoticeText(issue: ModelIssue, harness: string, models: readonly SessionModel[]): string {
  const model = modelByIdentity(models, issue.model)
  const next = issue.instead ? "" : " Choose another model."
  if (!model)
    return issue.source === "saved"
      ? `${harness} doesn't offer your default model, ${issue.model}, anymore.${next}`
      : `${harness} doesn't offer ${issue.model} anymore.${next}`
  const why = model.unavailable ? ` ${model.unavailable}` : ""
  return issue.source === "saved"
    ? `Your default model, ${model.label}, can't start.${why}${next}`
    : `${model.label} can't start.${why}${next}`
}
