import { useState } from "react"
import { RadioGroup } from "radix-ui"
import { CheckIcon, SlidersHorizontalIcon, ZapIcon } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { chooseComposerOption } from "@/state/composer-settings"
import type {
  ModelOption,
  ResolvedSetting,
  SettingValue,
} from "@mako/sessions/settings"
import type { ComposerSettingsView } from "./use-composer-settings"
import {
  optionLabel,
  settingSourceLabel,
  settingValueLabel,
} from "./settings-source"
import { cn } from "@/lib/utils"

export function ForeignEffortPicker({ view }: { view: ComposerSettingsView }) {
  const speed = view.options.find((option) => option.role === "speed")
  const details = view.options.filter((option) => option !== speed)
  return (
    <>
      {details.length > 0 ? (
        <OptionsPicker view={view} options={details} />
      ) : null}
      {speed ? <OptionsPicker view={view} options={[speed]} speed /> : null}
      {view.resolved.issues.length > 0 ? (
        <span
          role="status"
          className="text-danger max-w-[18rem] truncate text-label"
          title={view.resolved.issues.map((issue) => issue.message).join(" ")}
        >
          Check model settings
        </span>
      ) : null}
    </>
  )
}

function OptionsPicker({
  view,
  options,
  speed = false,
}: {
  view: ComposerSettingsView
  options: ModelOption[]
  speed?: boolean
}) {
  const [open, setOpen] = useState(false)
  const primary =
    options.find((option) => option.role === "reasoning") ?? options[0]!
  const current = view.resolved.options[primary.id] ?? { kind: "unknown" }
  const label = primary.role ? optionLabel(primary, current) : "Model options"
  const Icon = speed ? ZapIcon : SlidersHorizontalIcon
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={settingSourceLabel(current)}
          className="pressable no-drag flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-ui font-medium text-faint hover:bg-fill-hover hover:text-foreground aria-expanded:bg-fill-selected"
        >
          <Icon className="size-3 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="max-h-[24rem] w-[19rem] overflow-y-auto p-1"
      >
        {options.map((option) => (
          <OptionSection
            key={option.id}
            option={option}
            current={view.resolved.options[option.id] ?? { kind: "unknown" }}
            onChange={(value) => {
              chooseComposerOption(view.target, option.id, value)
              setOpen(false)
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  )
}

function OptionSection({
  option,
  current,
  onChange,
}: {
  option: ModelOption
  current: ResolvedSetting
  onChange(value: SettingValue): void
}) {
  const choices =
    option.kind === "boolean"
      ? [
          {
            value: false,
            label: option.role === "speed" ? "Standard" : "Off",
            description: undefined,
          },
          {
            value: true,
            label: option.role === "speed" ? "Fast" : "On",
            description: undefined,
          },
        ]
      : option.values
  return (
    <section className="pb-1">
      <p className="px-2 pt-1.5 pb-1 text-label font-medium text-faint">
        {option.label}
      </p>
      <p className="px-2 pb-1.5 text-label text-faint">
        {option.disabledReason ?? settingSourceLabel(current)}
      </p>
      <RadioGroup.Root
        aria-label={option.label}
        value={current.kind === "known" ? String(current.value) : ""}
        disabled={Boolean(option.disabledReason)}
        onValueChange={(value) => {
          const selected = choices.find(
            (entry) => String(entry.value) === value
          )
          if (selected) onChange(selected.value)
        }}
      >
        {choices.map((entry) => (
          <RadioGroup.Item
            key={String(entry.value)}
            value={String(entry.value)}
            className={cn(
              "pressable flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-50",
              current.kind === "known" &&
                current.value === entry.value &&
                "bg-fill-selected"
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-ui">
                {settingValueLabel(option, entry.value)}
              </span>
              {entry.description ? (
                <span className="block text-label text-faint">
                  {entry.description}
                </span>
              ) : null}
            </span>
            <RadioGroup.Indicator>
              <CheckIcon className="size-3.5 shrink-0" />
            </RadioGroup.Indicator>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    </section>
  )
}
