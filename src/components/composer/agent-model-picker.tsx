import { useMemo, useState } from "react"
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ListPlusIcon,
  PinOffIcon,
  Settings2Icon,
  ZapIcon,
} from "lucide-react"
import type { ModelOption, SettingValue } from "@mako/sessions/settings"
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu"
import { Keys } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/harness-meta"
import {
  chooseComposerModel,
  chooseComposerOption,
  resetComposerSettings,
} from "@/state/composer-settings"
import {
  addToLoadout,
  LOADOUT_LIMIT,
  removeFromLoadout,
  type LoadoutEntry,
} from "@/state/model-loadout"
import { modelKey, usePrefs } from "@/state/prefs"
import { providers, useProviders } from "@/state/providers"
import { shallowEqual } from "@/state/store"
import { setComposerHarness } from "@/state/threads"
import { fuzzy } from "@/lib/fuzzy"
import { cn } from "@/lib/utils"
import type { HarnessModel } from "@/lib/types"
import { settingSourceLabel, settingValueLabel } from "./settings-source"
import { useComposerSettings, type ComposerSettingsView } from "./use-composer-settings"

/**
 * Harness, model, reasoning and speed in one control.
 *
 * The chip reads what the next turn runs on: the harness's mark, the model
 * and its reasoning, and a bolt while the fast lane is on. Opening it puts
 * the loadout first (the five models a chord away), then every harness with
 * its models a hover away, then the selected model's own options. Choosing a
 * model in another harness moves the conversation there on send, exactly as
 * choosing the harness alone did when these were three controls.
 */
export function AgentModelPicker({ view }: { view: ComposerSettingsView }) {
  const [open, setOpen] = useState(false)
  const harness = view.target.harness
  const reasoning = view.options.find((option) => option.role === "reasoning")
  const speed = view.options.find((option) => option.role === "speed")
  const effort = reasoning ? knownValueLabel(view, reasoning) : undefined
  const fast = speed ? knownValueLabel(view, speed) === "Fast" : false
  const issues = view.resolved.issues

  return (
    <Menu
      open={open}
      modal={false}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          void providers.loadAll()
          void view.refresh().catch(() => {})
        }
      }}
    >
      <MenuTrigger asChild>
        <button
          type="button"
          data-model-picker
          data-harness={harness}
          aria-label={`Model: ${view.modelLabel}`}
          title={issues.length ? issues.map((issue) => issue.message).join(" ") : undefined}
          className={cn(
            "pressable no-drag flex h-7 max-w-[22rem] min-w-0 items-center gap-1.5 rounded-md px-2",
            "text-ui font-medium text-foreground/85",
            "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
            "hover:bg-fill-hover data-[state=open]:bg-fill-selected"
          )}
        >
          <HarnessIcon harness={harness} className="size-3.5" />
          <span className="truncate">{view.modelLabel}</span>
          {effort ? <span className="shrink-0 text-faint">{effort}</span> : null}
          {fast ? (
            <ZapIcon aria-label="Fast" className="size-3 shrink-0 fill-current text-foreground/70" />
          ) : null}
          {issues.length ? (
            <AlertCircleIcon aria-label="Check model settings" className="size-3 shrink-0 text-caution" />
          ) : null}
          <ChevronDownIcon className="size-3 shrink-0 text-faint/70" />
        </button>
      </MenuTrigger>
      <MenuContent side="top" align="start" className="w-[20rem]">
        <LoadoutRows view={view} />
        <MenuSeparator />
        <HarnessRows view={view} />
        <OptionRows view={view} />
        <MenuSeparator />
        <MenuItem
          onSelect={() =>
            window.dispatchEvent(new CustomEvent("mako:settings", { detail: "models" }))
          }
          className="text-muted-foreground"
        >
          <Settings2Icon className="size-3.5 shrink-0" />
          <span className="flex-1">Edit loadout and defaults</span>
          {reasoning ? (
            <span className="flex items-center gap-1.5 text-label text-faint">
              <Keys keys={["⌘", "⇧", "/"]} />
              effort
            </span>
          ) : null}
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

function knownValueLabel(view: ComposerSettingsView, option: ModelOption) {
  const current = view.resolved.options[option.id]
  return current?.kind === "known" ? settingValueLabel(option, current.value) : undefined
}

/** Pick `model` in `harness`, retargeting the composer when the harness changes. */
function chooseHarnessModel(view: ComposerSettingsView, harness: string, model: string) {
  if (harness !== view.target.harness) setComposerHarness(harness)
  chooseComposerModel(
    harness === view.target.harness
      ? view.target
      : { kind: "new", harness, cwd: view.target.cwd },
    model
  )
}

/* ------------------------------------------------------------ loadout */

function LoadoutRows({ view }: { view: ComposerSettingsView }) {
  const loadout = usePrefs((prefs) => prefs.modelLoadout)
  const current = view.model?.id
  const harness = view.target.harness
  const pinned = loadout.some((entry) => entry.harness === harness && entry.model === current)
  return (
    <>
      <MenuLabel>Loadout</MenuLabel>
      {loadout.map((entry, index) => (
        <LoadoutRow
          key={`${entry.harness}:${entry.model}`}
          entry={entry}
          index={index}
          active={entry.harness === harness && entry.model === current}
          effort={
            entry.harness === harness && entry.model === current
              ? currentEffort(view)
              : undefined
          }
          onChoose={() => chooseHarnessModel(view, entry.harness, entry.model)}
        />
      ))}
      {current && !pinned && loadout.length < LOADOUT_LIMIT ? (
        <MenuItem
          onSelect={(event) => {
            event.preventDefault()
            addToLoadout(harness, current)
          }}
          className="text-muted-foreground"
        >
          <ListPlusIcon className="size-3.5 shrink-0" />
          <span className="truncate">
            {loadout.length === 0 ? "Pin " : "Add "}
            {view.modelLabel}
            {loadout.length === 0 ? ` for ⌃⌘1` : ""}
          </span>
        </MenuItem>
      ) : null}
    </>
  )
}

function currentEffort(view: ComposerSettingsView) {
  const reasoning = view.options.find((option) => option.role === "reasoning")
  return reasoning ? knownValueLabel(view, reasoning) : undefined
}

function LoadoutRow({
  entry,
  index,
  active,
  effort,
  onChoose,
}: {
  entry: LoadoutEntry
  index: number
  active: boolean
  effort?: string
  onChoose(): void
}) {
  const label = useProviders((state) => {
    const models = state.profiles[entry.harness]?.models ?? []
    return models.find((model) => model.id === entry.model)?.label
  })
  return (
    <MenuItem onSelect={onChoose} className="group/loadout">
      <HarnessIcon harness={entry.harness} className="size-3.5" />
      <span className={cn("min-w-0 truncate", active ? "font-medium text-foreground" : "text-foreground/90")}>
        {label ?? entry.model}
      </span>
      <span className="min-w-0 flex-1 truncate text-label text-faint">
        {effort ?? harnessLabel(entry.harness)}
      </span>
      <button
        type="button"
        aria-label={`Remove ${label ?? entry.model} from the loadout`}
        onClick={(event) => {
          event.stopPropagation()
          removeFromLoadout(index)
        }}
        className="rounded p-0.5 text-faint opacity-0 transition-opacity duration-150 group-data-[highlighted]/loadout:opacity-100 hover:text-foreground"
      >
        <PinOffIcon className="size-3" />
      </button>
      {active ? <CheckIcon className="size-3.5 shrink-0" /> : <Keys keys={["⌃", "⌘", String(index + 1)]} />}
    </MenuItem>
  )
}

/* ----------------------------------------------------------- harnesses */

function HarnessRows({ view }: { view: ComposerSettingsView }) {
  const harnesses = useProviders((state) => Object.keys(state.profiles), shallowEqual)
  return (
    <>
      <MenuLabel>Harnesses</MenuLabel>
      {harnesses.map((harness) => (
        <HarnessRow key={harness} harness={harness} composer={view} />
      ))}
    </>
  )
}

function HarnessRow({ harness, composer }: { harness: string; composer: ComposerSettingsView }) {
  const view = useComposerSettings(harness)
  const profile = view.profile
  const active = composer.target.harness === harness
  if (profile && !profile.pending && !profile.available) {
    return (
      <MenuItem
        onSelect={() =>
          window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))
        }
      >
        <HarnessIcon harness={harness} className="size-3.5" tinted={false} />
        <span className="flex-1 truncate text-foreground/70">{harnessLabel(harness)}</span>
        <span className="text-label text-faint">Set up</span>
      </MenuItem>
    )
  }
  return (
    <MenuSub>
      {/* A click takes the harness on its own defaults; the submenu beside
          it still offers the rest of its models. */}
      <MenuSubTrigger onClick={() => { if (!active) setComposerHarness(harness) }}>
        <HarnessIcon harness={harness} className="size-3.5" />
        <span className={cn("truncate", active ? "font-medium text-foreground" : "text-foreground/90")}>
          {harnessLabel(harness)}
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-label text-faint">
          {profile?.pending || !profile ? "Checking…" : view.modelLabel}
        </span>
      </MenuSubTrigger>
      <MenuSubContent className="w-[21rem]">
        <HarnessModels view={view} active={active} composer={composer} />
      </MenuSubContent>
    </MenuSub>
  )
}

function HarnessModels({
  view,
  active,
  composer,
}: {
  view: ComposerSettingsView
  active: boolean
  composer: ComposerSettingsView
}) {
  const [query, setQuery] = useState("")
  const favorites = usePrefs((prefs) => prefs.favoriteModels)
  const loadout = usePrefs((prefs) => prefs.modelLoadout)
  const harness = view.target.harness
  const profile = view.profile
  const models = useMemo(
    () => rankModels(profile?.models ?? [], query, favorites, harness),
    [favorites, harness, profile?.models, query]
  )
  const selected = view.model?.id
  const searchable = (profile?.models.length ?? 0) > 8
  const failure = view.error ?? profile?.configurationError ?? profile?.error

  return (
    <>
      {searchable ? (
        <div className="px-1 pt-1 pb-1.5">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key.length === 1 || event.key === "Backspace") event.stopPropagation()
            }}
            placeholder={`Search ${harnessLabel(harness)} models`}
            className="h-7 w-full rounded-md bg-raised px-2 text-ui placeholder:text-faint focus:outline-none"
          />
        </div>
      ) : (
        <MenuLabel>{harnessLabel(harness)}</MenuLabel>
      )}
      {failure ? <p className="px-2 pb-1.5 text-label text-caution">{failure}</p> : null}
      <div className="max-h-[22rem] overflow-y-auto overscroll-contain">
        {models.map((model) => {
          const index = loadout.findIndex(
            (entry) => entry.harness === harness && entry.model === model.id
          )
          return (
            <ModelRow
              key={model.id}
              model={model}
              selected={active && selected === model.id}
              loadoutIndex={index}
              onChoose={() => chooseHarnessModel(composer, harness, model.id)}
              onLoadout={() => (index >= 0 ? removeFromLoadout(index) : addToLoadout(harness, model.id))}
            />
          )
        })}
        {profile && !profile.pending && models.length === 0 ? (
          <p className="px-2 py-4 text-center text-ui text-faint">
            {query ? "No models match." : "This harness reported no models."}
          </p>
        ) : null}
        {!profile || profile.pending ? (
          <p className="shimmer px-2 py-3 text-ui text-faint">Asking {harnessLabel(harness)} for its models…</p>
        ) : null}
      </div>
      {active ? (
        <>
          <MenuSeparator />
          <MenuItem onSelect={() => resetComposerSettings(view.target)} className="text-muted-foreground">
            <span className="flex-1">
              {view.target.kind === "new" ? "Use provider defaults" : "Use session settings"}
            </span>
            <span className="truncate text-label text-faint">{settingSourceLabel(view.resolved.model)}</span>
          </MenuItem>
        </>
      ) : null}
    </>
  )
}

function ModelRow({
  model,
  selected,
  loadoutIndex,
  onChoose,
  onLoadout,
}: {
  model: HarnessModel
  selected: boolean
  loadoutIndex: number
  onChoose(): void
  onLoadout(): void
}) {
  const pinned = loadoutIndex >= 0
  return (
    <MenuItem onSelect={onChoose} className="group/model py-1.5">
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", selected ? "font-medium text-foreground" : "text-foreground/90")}>
          {model.label}
        </span>
        {model.description ? (
          <span className="block truncate text-label text-faint">{model.description}</span>
        ) : null}
      </span>
      {model.contextWindow ? (
        <span className="shrink-0 text-label text-faint">
          {Math.round(model.contextWindow / 1000)}K context
        </span>
      ) : null}
      <button
        type="button"
        aria-label={pinned ? `Remove ${model.label} from the loadout` : `Add ${model.label} to the loadout`}
        title={pinned ? `In the loadout, ⌃⌘${loadoutIndex + 1}` : "Add to the loadout"}
        onClick={(event) => {
          event.stopPropagation()
          onLoadout()
        }}
        className={cn(
          "rounded p-0.5 text-faint transition-opacity duration-150 hover:text-foreground",
          pinned ? "text-foreground/70" : "opacity-0 group-data-[highlighted]/model:opacity-100"
        )}
      >
        <ListPlusIcon className="size-3.5" />
      </button>
      <CheckIcon className={cn("size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} />
    </MenuItem>
  )
}

function rankModels(
  models: HarnessModel[],
  query: string,
  favorites: string[],
  harness: string
): HarnessModel[] {
  const term = query.trim()
  if (!term) {
    const order = new Map(favorites.map((key, index) => [key, index]))
    return [...models].sort((left, right) => {
      const leftOrder = order.get(modelKey(harness, left.id))
      const rightOrder = order.get(modelKey(harness, right.id))
      if (leftOrder === undefined && rightOrder === undefined) return 0
      if (leftOrder === undefined) return 1
      if (rightOrder === undefined) return -1
      return leftOrder - rightOrder
    })
  }
  return models
    .flatMap((model) => {
      const match = fuzzy(
        term,
        `${model.label} ${model.id} ${model.launchId ?? ""} ${(model.aliases ?? []).join(" ")} ${model.description ?? ""}`
      )
      return match ? [{ model, score: match.score }] : []
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.model)
}

/* ------------------------------------------------------------- options */

function OptionRows({ view }: { view: ComposerSettingsView }) {
  const ordered = [...view.options].sort((left, right) => roleOrder(left) - roleOrder(right))
  const issues = view.resolved.issues
  if (ordered.length === 0 && issues.length === 0) return null
  return (
    <>
      <MenuSeparator />
      <MenuLabel>{view.model?.label ?? "Model"} options</MenuLabel>
      {ordered.map((option) =>
        isSwitch(option) ? (
          <SwitchOption key={option.id} view={view} option={option} />
        ) : (
          <SelectOption key={option.id} view={view} option={option} />
        )
      )}
      {issues.map((issue) => (
        <p key={issue.option} className="flex items-start gap-2 px-2 py-1.5 text-label text-caution">
          <AlertCircleIcon className="mt-px size-3 shrink-0" />
          {issue.message}
        </p>
      ))}
    </>
  )
}

function roleOrder(option: ModelOption) {
  return option.role === "reasoning" ? 0 : option.role === "speed" ? 1 : 2
}

/** Two-valued options read as a switch: on/off, or a provider's fast/standard pair. */
function isSwitch(option: ModelOption) {
  return option.kind === "boolean" || Boolean(option.booleanValues) || option.presentation === "toggle"
}

function optionName(option: ModelOption) {
  if (option.role === "reasoning") return "Effort"
  if (option.role === "speed") return "Fast"
  return option.label
}

function SwitchOption({ view, option }: { view: ComposerSettingsView; option: ModelOption }) {
  const current = view.resolved.options[option.id]
  const on =
    current?.kind === "known" &&
    (option.kind === "boolean"
      ? current.value === true
      : option.booleanValues
        ? current.value === option.booleanValues.on
        : settingValueLabel(option, current.value) === "Fast")
  const next = (): SettingValue | undefined => {
    if (option.kind === "boolean") return !on
    if (option.booleanValues) return on ? option.booleanValues.off : option.booleanValues.on
    const values = option.values.map((choice) => choice.value)
    const index = values.findIndex((value) => current?.kind === "known" && value === current.value)
    return values[(index + 1) % values.length]
  }
  return (
    <MenuItem
      disabled={Boolean(option.disabledReason)}
      title={option.disabledReason ?? settingSourceLabel(current ?? { kind: "unknown" })}
      onSelect={(event) => {
        event.preventDefault()
        const value = next()
        if (value !== undefined) chooseComposerOption(view.target, option.id, value)
      }}
    >
      {option.role === "speed" ? <ZapIcon className="size-3.5 shrink-0 text-faint" /> : <OptionGlyph />}
      <span className="flex-1 truncate">{optionName(option)}</span>
      {option.role === "speed" ? <Keys keys={["⌘", "⇧", "E"]} /> : null}
      <SwitchMark on={on} />
    </MenuItem>
  )
}

function SelectOption({ view, option }: { view: ComposerSettingsView; option: ModelOption }) {
  if (option.kind !== "select") return null
  const current = view.resolved.options[option.id]
  const value = current?.kind === "known" ? String(current.value) : ""
  return (
    <MenuSub>
      <MenuSubTrigger disabled={Boolean(option.disabledReason)} title={option.disabledReason}>
        <OptionGlyph />
        <span className="flex-1 truncate">{optionName(option)}</span>
        <span className="truncate text-label text-faint">
          {current?.kind === "known" ? settingValueLabel(option, current.value) : "Not reported"}
        </span>
      </MenuSubTrigger>
      <MenuSubContent className="w-[14rem]">
        <MenuLabel>{option.label}</MenuLabel>
        <MenuRadioGroup
          value={value}
          onValueChange={(picked) => {
            const choice = option.values.find((entry) => String(entry.value) === picked)
            if (choice) chooseComposerOption(view.target, option.id, choice.value)
          }}
        >
          {option.values.map((choice) => (
            <MenuRadioItem key={choice.value} value={String(choice.value)} className="py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{choice.label}</span>
                {choice.description ? (
                  <span className="block truncate text-label text-faint">{choice.description}</span>
                ) : null}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <p className="px-2 pt-1 pb-1.5 text-label text-faint">
          {settingSourceLabel(current ?? { kind: "unknown" })}
        </p>
      </MenuSubContent>
    </MenuSub>
  )
}

function OptionGlyph() {
  return <span aria-hidden className="size-3.5 shrink-0" />
}

function SwitchMark({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-4 w-7 shrink-0 items-center rounded-full p-[2px] [transition:background-color_150ms_ease]",
        on ? "bg-foreground/80" : "bg-foreground/15"
      )}
    >
      <span
        className={cn(
          "block size-3 rounded-full bg-background [transition:transform_180ms_var(--ease-out)]",
          on ? "translate-x-3" : "translate-x-0"
        )}
      />
    </span>
  )
}