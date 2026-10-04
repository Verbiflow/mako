import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select"
import { HarnessIcon, ProviderIcon } from "@/components/ui/provider-icon"
import { parseAgentModelId, utilityModelName } from "../../../electron/contracts/utility-work"
import {
  UTILITY_AUTOMATIC,
  UTILITY_OFF,
  type UtilityModelOption,
  type UtilityTask,
  type UtilityTaskState,
} from "@/lib/types"

/**
 * The model a small task runs on: Automatic (and what that is now), Off for
 * titles, each signed-in harness's models with its light one first, then
 * each model connection. A choice that went away stays shown, marked
 * unavailable, so the row never pretends something else was chosen.
 */
export function UtilityModelPicker({
  task,
  state,
  label,
  className = "w-64 max-w-full",
  disabled = false,
  onChoose,
}: {
  task: UtilityTask
  state: UtilityTaskState | undefined
  label: string
  className?: string
  disabled?: boolean
  onChoose(choice: string): void
}) {
  const choice = state?.choice ?? UTILITY_AUTOMATIC
  const listed = state?.options ?? []
  const options: SearchSelectOption[] = [
    {
      value: UTILITY_AUTOMATIC,
      label: "Automatic",
      detail: state?.choice === UTILITY_AUTOMATIC && state.resolved ? utilityModelName(state.resolved) : "A light model from your first harness",
      keywords: "auto default",
    },
    ...(task === "title" ? [{ value: UTILITY_OFF, label: "Off", detail: "Keep the names agents give" }] : []),
    ...listed.map((option) => ({
      value: option.id,
      label: option.label,
      detail: option.light ? `${option.via} · light` : option.via,
      keywords: `${option.via} ${option.source}`,
      icon: icon(option),
    })),
  ]
  if (!options.some((option) => option.value === choice))
    options.push({ value: choice, label: parseAgentModelId(choice)?.model ?? choice, detail: "Unavailable" })
  return (
    <SearchSelect
      value={choice}
      label={label}
      searchPlaceholder="Search models"
      className={className}
      disabled={disabled || !state}
      options={options}
      onChange={onChoose}
    />
  )
}

function icon(option: UtilityModelOption) {
  return option.kind === "agent"
    ? <HarnessIcon harness={option.source} tinted={false} className="size-3.5" />
    : <ProviderIcon provider={option.source} tinted={false} className="size-3.5" />
}
