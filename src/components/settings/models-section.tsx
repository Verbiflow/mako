import { useEffect, useState, type DragEvent } from "react"
import { z } from "zod"
import { CheckIcon, ChevronDownIcon, ListPlusIcon, XIcon } from "lucide-react"
import {
  optionDefault,
  type ModelOption,
  type SessionSettings,
  type SettingValue,
} from "@mako/sessions/settings"
import { Chip, Keys, ListCard, Segmented, SettingRow, Toggle } from "@/components/ui/kit"
import { Collapse } from "@/components/ui/collapse"
import { HarnessIcon } from "@/components/ui/provider-icon"
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import type { HarnessModel } from "@/lib/types"
import { settingValueLabel } from "@/components/composer/settings-source"
import { harnessDefaults, saveHarnessDefaults } from "@/state/composer-settings"
import {
  addToLoadout,
  LOADOUT_LIMIT,
  placeInLoadout,
  removeFromLoadout,
  type LoadoutEntry,
} from "@/state/model-loadout"
import { usePrefs } from "@/state/prefs"
import { providers, useProviders } from "@/state/providers"
import { shallowEqual } from "@/state/store"

const DRAG_TYPE = "application/x-mako-loadout"

/**
 * Models: the loadout the composer's picker opens on and ⌃⌘1–5 reach, and
 * what each harness starts a new conversation on.
 */
export function ModelsSection() {
  const harnesses = useProviders((state) => Object.keys(state.profiles), shallowEqual)
  useEffect(() => {
    void providers.loadAll()
  }, [])
  return (
    <>
      <LoadoutSlots />
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-ui font-medium">Defaults for new conversations</h3>
          <p className="mt-0.5 text-label text-muted-foreground">
            Each harness starts here. The composer can still change the model for one conversation.
          </p>
        </div>
        {harnesses.map((harness) => (
          <HarnessDefaults key={harness} harness={harness} />
        ))}
      </section>
    </>
  )
}

/* ------------------------------------------------------------- loadout */

function LoadoutSlots() {
  const loadout = usePrefs((prefs) => prefs.modelLoadout)
  const [over, setOver] = useState<number | null>(null)
  const drop = (event: DragEvent, at: number) => {
    event.preventDefault()
    setOver(null)
    const entry = readDrag(event)
    if (entry) placeInLoadout(entry, at)
  }
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-ui font-medium">Loadout</h3>
        <p className="mt-0.5 text-label text-muted-foreground">
          The models the composer's picker lists first, a chord away. Drag to reorder, or drag a
          model from a harness below into a slot.
        </p>
      </div>
      <div className="grid grid-cols-5 gap-2">
        {Array.from({ length: LOADOUT_LIMIT }, (_, index) => {
          const entry = loadout[index]
          const target = over === index
          const events = {
            onDragOver: (event: DragEvent) => {
              if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = "move"
              setOver(index)
            },
            onDragLeave: () => setOver((current) => (current === index ? null : current)),
            onDrop: (event: DragEvent) => drop(event, index),
          }
          return entry ? (
            <LoadoutTile key={`${entry.harness}:${entry.model}`} entry={entry} index={index} target={target} {...events} />
          ) : (
            <div
              key={`empty-${index}`}
              {...events}
              className={cn(
                "flex h-[5.5rem] flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed text-label text-faint transition-colors duration-150",
                target ? "border-foreground/40 bg-fill-hover text-muted-foreground" : "border-border"
              )}
            >
              {index === loadout.length ? "Drop a model here" : "Empty"}
              <Keys keys={["⌃", "⌘", String(index + 1)]} />
            </div>
          )
        })}
      </div>
    </section>
  )
}

function LoadoutTile({
  entry,
  index,
  target,
  ...events
}: {
  entry: LoadoutEntry
  index: number
  target: boolean
  onDragOver(event: DragEvent): void
  onDragLeave(): void
  onDrop(event: DragEvent): void
}) {
  const model = useModel(entry.harness, entry.model)
  const [dragging, setDragging] = useState(false)
  return (
    <div
      draggable
      onDragStart={(event) => {
        writeDrag(event, entry)
        setDragging(true)
      }}
      onDragEnd={() => setDragging(false)}
      {...events}
      className={cn(
        "group/tile relative flex h-[5.5rem] cursor-grab flex-col justify-between rounded-[10px] bg-shell/55 p-3 active:cursor-grabbing",
        "[box-shadow:inset_0_0_0_0.5px_var(--hairline)] transition-[background-color,opacity,box-shadow] duration-150",
        target && "bg-fill-hover [box-shadow:inset_0_0_0_1px_var(--border)]",
        dragging && "opacity-40"
      )}
    >
      <div className="flex items-start justify-between">
        <HarnessIcon harness={entry.harness} className="size-5" />
        <button
          type="button"
          aria-label={`Remove ${model?.label ?? entry.model} from the loadout`}
          onClick={() => removeFromLoadout(index)}
          className="pressable -mt-1 -mr-1 rounded p-1 text-faint opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100 hover:text-foreground focus-visible:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="min-w-0">
        <p className="truncate text-ui font-medium">{model?.label ?? entry.model}</p>
        <p className="flex items-center justify-between gap-2 text-label text-faint">
          <span className="truncate">{harnessLabel(entry.harness)}</span>
          <span className="shrink-0 tabular">⌃⌘{index + 1}</span>
        </p>
      </div>
    </div>
  )
}

function writeDrag(event: DragEvent, entry: LoadoutEntry) {
  event.dataTransfer.effectAllowed = "move"
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(entry))
}

const DraggedEntry = z.object({ harness: z.string(), model: z.string() })

function readDrag(event: DragEvent): LoadoutEntry | null {
  try {
    const parsed = DraggedEntry.safeParse(JSON.parse(event.dataTransfer.getData(DRAG_TYPE)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function useModel(harness: string, id: string): HarnessModel | undefined {
  return useProviders((state) =>
    state.profiles[harness]?.models.find((model) => model.id === id)
  )
}

/* ------------------------------------------------------------ defaults */

function HarnessDefaults({ harness }: { harness: string }) {
  const profile = useProviders((state) => state.profiles[harness])
  const preference = usePrefs((prefs) => prefs.providerSettings[harness])
  const loadout = usePrefs((prefs) => prefs.modelLoadout)
  const [showModels, setShowModels] = useState(false)
  const ready = profile && !profile.pending
  const { resolved, model, options } = harnessDefaults(harness, profile, preference)
  const models = profile?.models ?? []

  const save = (settings: SessionSettings) => saveHarnessDefaults(harness, settings)
  const chooseModel = (id: string) => {
    const next = models.find((entry) => entry.id === id)
    // Speed carries to the new model when it has the same lane; reasoning
    // levels are the model's own, so they start from its default.
    const carried = Object.fromEntries(
      Object.entries(resolved.settings.options ?? {}).filter(([option]) =>
        next?.options.some((entry) => entry.id === option && entry.role === "speed")
      )
    )
    save({ model: id, options: carried })
  }
  const chooseOption = (id: string, value: SettingValue) =>
    save({ ...resolved.settings, options: { ...resolved.settings.options, [id]: value } })

  return (
    <ListCard>
      <div className="flex items-center gap-3 py-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-raised [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
          <HarnessIcon harness={harness} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ui font-medium">{harnessLabel(harness)}</p>
          <p className="truncate text-label text-faint">
            {!ready
              ? "Asking for its models…"
              : !profile.available
                ? (profile.error ?? "Not set up")
                : models.length === 1
                  ? "1 model"
                  : `${models.length} models`}
          </p>
        </div>
        {preference?.source === "saved" ? <Chip>Saved</Chip> : null}
      </div>
      {ready && profile.available ? (
        <>
          <SettingRow title="Model" description="What a new conversation starts on">
            <ModelSelect
              models={models}
              value={model?.id}
              label={model?.label ?? "Provider default"}
              onChange={chooseModel}
            />
          </SettingRow>
          {options.map((option) => (
            <OptionRow
              key={option.id}
              option={option}
              value={resolved.options[option.id]}
              onChange={(value) => chooseOption(option.id, value)}
            />
          ))}
          <div className="py-2">
            <button
              type="button"
              aria-expanded={showModels}
              onClick={() => setShowModels((value) => !value)}
              className="pressable flex h-7 items-center gap-1.5 rounded-md px-1.5 text-label text-muted-foreground transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
            >
              <ChevronDownIcon
                className={cn(
                  "size-3.5 transition-transform duration-200 ease-[var(--ease-out)]",
                  showModels ? "rotate-0" : "-rotate-90"
                )}
              />
              All {harnessLabel(harness)} models
            </button>
            <Collapse open={showModels}>
              <div className="grid grid-cols-2 gap-1 pt-1.5 pb-1">
                {models.map((entry) => (
                  <ModelChip
                    key={entry.id}
                    harness={harness}
                    model={entry}
                    slot={loadout.findIndex((held) => held.harness === harness && held.model === entry.id)}
                  />
                ))}
              </div>
            </Collapse>
          </div>
        </>
      ) : null}
    </ListCard>
  )
}

function ModelSelect({
  models,
  value,
  label,
  onChange,
}: {
  models: HarnessModel[]
  value: string | undefined
  label: string
  onChange(id: string): void
}) {
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <button
          type="button"
          className="pressable flex h-7 max-w-[16rem] min-w-[10rem] items-center justify-between gap-2 rounded-md bg-raised px-2.5 text-ui [box-shadow:inset_0_0_0_0.5px_var(--hairline)] transition-colors duration-100 hover:bg-fill-hover data-[state=open]:bg-fill-selected"
        >
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-faint" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="max-h-[22rem] w-[18rem] overflow-y-auto">
        <MenuRadioGroup value={value ?? ""} onValueChange={onChange}>
          {models.map((model) => (
            <MenuRadioItem key={model.id} value={model.id} className="py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{model.label}</span>
                {model.description ? (
                  <span className="block truncate text-label text-faint">{model.description}</span>
                ) : null}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  )
}

function OptionRow({
  option,
  value,
  onChange,
}: {
  option: ModelOption
  value: { kind: "known"; value: SettingValue } | { kind: "unknown" } | undefined
  onChange(value: SettingValue): void
}) {
  const current = value?.kind === "known" ? value.value : optionDefault(option)
  const title = option.role === "reasoning" ? "Reasoning" : option.role === "speed" ? "Fast" : option.label
  const description =
    option.role === "speed"
      ? "Answers sooner where the provider offers a faster lane"
      : option.role === "reasoning"
        ? "How long the model thinks before it answers"
        : undefined
  const pair = option.kind === "select" ? option.booleanValues : undefined
  if (option.kind === "boolean" || pair) {
    const on = pair ? current === pair.on : current === true
    return (
      <SettingRow title={title} description={description}>
        <Toggle
          label={title}
          on={on}
          disabled={Boolean(option.disabledReason)}
          onChange={() => onChange(pair ? (on ? pair.off : pair.on) : !on)}
        />
      </SettingRow>
    )
  }
  const choices = option.values.map((choice) => ({ value: choice.value, label: choice.label }))
  return (
    <SettingRow title={title} description={description}>
      {choices.length <= 5 ? (
        <Segmented
          label={title}
          value={current === undefined ? "" : String(current)}
          options={choices}
          disabled={Boolean(option.disabledReason)}
          onChange={onChange}
        />
      ) : (
        <Menu modal={false}>
          <MenuTrigger asChild>
            <button
              type="button"
              className="pressable flex h-7 min-w-[8rem] items-center justify-between gap-2 rounded-md bg-raised px-2.5 text-ui [box-shadow:inset_0_0_0_0.5px_var(--hairline)] hover:bg-fill-hover data-[state=open]:bg-fill-selected"
            >
              {current === undefined ? "Default" : settingValueLabel(option, current)}
              <ChevronDownIcon className="size-3.5 text-faint" />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="w-[14rem]">
            <MenuRadioGroup value={current === undefined ? "" : String(current)} onValueChange={onChange}>
              {choices.map((choice) => (
                <MenuRadioItem key={choice.value} value={choice.value}>
                  {choice.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      )}
    </SettingRow>
  )
}

function ModelChip({ harness, model, slot }: { harness: string; model: HarnessModel; slot: number }) {
  const entry = { harness, model: model.id }
  const pinned = slot >= 0
  return (
    <div
      draggable
      onDragStart={(event) => writeDrag(event, entry)}
      className="group/chip flex h-8 cursor-grab items-center gap-2 rounded-md px-2 text-ui transition-colors duration-100 hover:bg-fill-hover active:cursor-grabbing"
    >
      <span className="min-w-0 flex-1 truncate text-foreground/90">{model.label}</span>
      {pinned ? (
        <span className="flex items-center gap-1 text-label text-faint">
          <CheckIcon className="size-3" />
          ⌃⌘{slot + 1}
        </span>
      ) : (
        <button
          type="button"
          aria-label={`Add ${model.label} to the loadout`}
          onClick={() => addToLoadout(harness, model.id)}
          className="pressable rounded p-1 text-faint opacity-0 transition-opacity duration-150 group-hover/chip:opacity-100 hover:text-foreground focus-visible:opacity-100"
        >
          <ListPlusIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}
