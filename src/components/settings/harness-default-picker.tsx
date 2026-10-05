import { ChevronDownIcon, RotateCcwIcon } from "lucide-react"
import type { ResolvedSetting, SessionSettings } from "@mako/sessions/settings"
import { workDefault } from "../../../electron/contracts/harness-defaults"
import { ModelList, ModelOptionRows, ModelSummary, type ModelChoice } from "@/components/composer/agent-model-picker"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import type { HarnessProfile } from "@/lib/types"
import { harnessDefaults, resetHarnessDefaults, saveHarnessDefaults } from "@/state/composer-settings"
import { usePrefs } from "@/state/prefs"
import { harnessDefaultsFor } from "@/state/descriptors"
import { useThreads } from "@/state/thread-store"

/**
 * What a harness's new conversations and project setups start on, chosen
 * with the composer's own picker: every model with its description and
 * context window, then the chosen model's effort, fast lane and context.
 */
export function HarnessDefaultPicker({ harness, profile }: { harness: string; profile: HarnessProfile }) {
  const preference = usePrefs((prefs) => prefs.providerSettings[harness])
  const { resolved, model, options } = harnessDefaults(harness, profile, preference)
  const defaults = useThreads((state) => harnessDefaultsFor(state, harness))
  const recommended = workDefault(defaults, profile.models) ? "Mako's recommendation" : `${harnessLabel(harness)}'s own default`
  const save = (settings: SessionSettings) => saveHarnessDefaults(harness, settings, profile)
  const choice: ModelChoice = {
    harness,
    models: profile.models,
    model,
    options,
    resolved,
    chooseOption: (id, value) => save({ ...resolved.settings, options: { ...resolved.settings.options, [id]: value } }),
    source: (setting: ResolvedSetting) =>
      setting.kind !== "known" ? "The harness has not said" : setting.source === "saved" ? "Your choice" : `From ${recommended}`,
  }
  const chooseModel = (id: string) => {
    const next = profile.models.find((entry) => entry.id === id)
    // The fast lane carries to a model with the same lane; reasoning levels
    // are each model's own, so they start from the new model's default.
    const carried = Object.fromEntries(
      Object.entries(resolved.settings.options ?? {}).filter(([option]) =>
        next?.options.some((entry) => entry.id === option && entry.role === "speed")
      )
    )
    save({ model: id, options: carried })
  }
  const label = model?.label ?? (resolved.model.kind === "known" ? resolved.model.value : "Its own default")

  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`${harnessLabel(harness)} starts on ${label}`}
          title={preference ? `Your choice. ${recommended} is in the menu.` : `Following ${recommended}`}
          className={cn(
            "pressable flex h-7 max-w-[17rem] min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2",
            "text-ui font-medium text-foreground/85",
            "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
            "hover:bg-fill-hover data-[state=open]:bg-fill-selected"
          )}
        >
          {preference ? <span aria-label="Your choice" className="size-1.5 shrink-0 rounded-full bg-foreground/60" /> : null}
          <ModelSummary choice={choice} label={label} />
          <ChevronDownIcon className="size-3 shrink-0 text-faint/70" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-[21rem]">
        <ModelList harness={harness} profile={profile} selected={model?.id} onChoose={chooseModel} />
        <ModelOptionRows choice={choice} />
        <MenuSeparator />
        {preference ? (
          <MenuItem onSelect={() => resetHarnessDefaults(harness)} className="text-muted-foreground">
            <RotateCcwIcon className="size-3.5 shrink-0" />
            <span className="flex-1 truncate">Use {recommended}</span>
          </MenuItem>
        ) : (
          <p className="px-2 py-1.5 text-label text-faint">
            Following {recommended}, which moves to newer models as they ship.
          </p>
        )}
      </MenuContent>
    </Menu>
  )
}
