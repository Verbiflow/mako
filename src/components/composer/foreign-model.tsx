import { useMemo, useState } from "react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Eyebrow } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/components/rail/harness-meta"
import {
  chooseComposerModel,
  resetComposerSettings,
} from "@/state/composer-settings"
import type { ComposerSettingsView } from "./use-composer-settings"
import { settingSourceLabel } from "./settings-source"
import { fuzzy } from "@/lib/fuzzy"
import { cn } from "@/lib/utils"
import { modelKey, toggleFavoriteModel, usePrefs } from "@/state/prefs"
import type { HarnessModel } from "@/lib/types"
import { CheckIcon, ChevronDownIcon, ListPlusIcon, StarIcon } from "lucide-react"
import { addToLoadout, removeFromLoadout } from "@/state/model-loadout"

export function ForeignModelPicker({ view }: { view: ComposerSettingsView }) {
  const { target, profile, resolved, model: selected, refresh } = view
  const harness = target.harness
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const favorites = usePrefs((prefs) => prefs.favoriteModels)
  const loadout = usePrefs((prefs) => prefs.modelLoadout)
  const identity =
    resolved.model.kind === "known" ? resolved.model.value : undefined
  const effective = selected?.id ?? identity
  const label = view.modelLabel
  const models = useMemo(
    () => rankModels(profile?.models ?? [], query, favorites, harness),
    [favorites, harness, profile?.models, query]
  )

  const set = (model: string) => {
    chooseComposerModel(target, model)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void refresh().catch(() => {})
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Model: ${label}`}
          className={cn(
            "pressable no-drag flex h-7 max-w-[15rem] min-w-0 items-center gap-1.5 rounded-md px-2",
            "text-ui font-medium text-foreground/85",
            "[transition:transform_var(--duration-press)_var(--ease-out),background-color_120ms_ease]",
            "hover:bg-fill-hover aria-expanded:bg-fill-selected"
          )}
        >
          {/* Once the harness chip is down to its glyph, repeating it here says nothing. */}
          <span data-collapse="2" className="flex shrink-0">
            <HarnessIcon harness={harness} className="size-3.5" />
          </span>
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-3 shrink-0 text-faint/70" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-[23rem] gap-0 p-0"
      >
        <div className="border-b border-hairline px-2 pt-2 pb-1.5">
          <Eyebrow className="px-0.5 pb-1">
            {harnessLabel(harness)} models
          </Eyebrow>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            className="h-7 w-full rounded-md bg-raised px-2 text-ui placeholder:text-faint focus:outline-none"
          />
        </div>
        <div className="border-b border-hairline p-1">
          <button
            type="button"
            className="pressable w-full rounded-md px-2 py-2 text-left text-ui hover:bg-fill-hover"
            onClick={() => {
              resetComposerSettings(target)
              setOpen(false)
            }}
          >
            {target.kind === "new"
              ? "Use provider defaults"
              : "Use session settings"}
          </button>
          <p className="px-2 pb-1 text-label text-faint">
            {settingSourceLabel(resolved.model)}
          </p>
          {view.error || profile?.configurationError || profile?.error ? (
            <p className="px-2 pb-1 text-label text-faint">
              {view.error ?? profile?.configurationError ?? profile?.error}
            </p>
          ) : null}
        </div>
        <div className="max-h-[20rem] overflow-y-auto overscroll-contain p-1">
          {models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              selected={effective === model.id}
              favorite={favorites.includes(modelKey(harness, model.id))}
              loadoutIndex={loadout.findIndex(
                (entry) => entry.harness === harness && entry.model === model.id
              )}
              onChoose={() => set(model.id)}
              onFavorite={() =>
                toggleFavoriteModel(modelKey(harness, model.id))
              }
              onLoadout={(index) => {
                if (index >= 0) removeFromLoadout(index)
                else addToLoadout(harness, model.id)
              }}
            />
          ))}
          {profile && models.length === 0 ? (
            <p className="px-2 py-5 text-center text-ui text-faint">
              No models match.
            </p>
          ) : null}
        </div>
        <div className="border-t border-hairline px-2 py-1.5 text-label text-faint">
          {profile?.models.length ?? 0} models reported by the provider
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ModelRow({
  model,
  selected,
  favorite,
  loadoutIndex,
  onChoose,
  onFavorite,
  onLoadout,
}: {
  model: HarnessModel
  selected: boolean
  favorite: boolean
  loadoutIndex: number
  onChoose: () => void
  onFavorite: () => void
  onLoadout: (index: number) => void
}) {
  const optionSummary = model.options
    .map((option) =>
      option.kind === "boolean"
        ? option.label
        : `${option.values.length} ${option.label.toLowerCase()} levels`
    )
    .join(" · ")
  return (
    <div
      className={cn(
        "group/model flex items-center rounded-md transition-colors duration-100",
        selected ? "bg-fill-selected" : "hover:bg-fill-hover"
      )}
    >
      <button
        type="button"
        onClick={onChoose}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
      >
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-ui",
              selected ? "font-medium text-foreground" : "text-foreground/90"
            )}
          >
            {model.label}
          </span>
          <span className="mt-0.5 block truncate font-mono text-label text-faint">
            {model.id}
          </span>
          {model.description || optionSummary ? (
            <span className="mt-0.5 block truncate text-label text-faint/80">
              {model.description || optionSummary}
            </span>
          ) : null}
        </span>
        {model.contextWindow ? (
          <span className="shrink-0 text-label text-faint">
            {Math.round(model.contextWindow / 1000)}K context
          </span>
        ) : null}
        {selected ? (
          <CheckIcon className="size-3.5 shrink-0 text-foreground" />
        ) : null}
      </button>
      <button
        type="button"
        aria-label={
          loadoutIndex >= 0
            ? `Remove ${model.label} from the loadout`
            : `Add ${model.label} to the loadout`
        }
        title={
          loadoutIndex >= 0
            ? `In the loadout — ⌃⌘${loadoutIndex + 1}`
            : "Add to the loadout (⌃⌘1–5)"
        }
        onClick={() => onLoadout(loadoutIndex)}
        className={cn(
          "rounded p-1 text-faint transition-opacity duration-150 hover:text-foreground",
          loadoutIndex >= 0
            ? "text-foreground/70"
            : "opacity-0 group-hover/model:opacity-100 focus:opacity-100"
        )}
      >
        <ListPlusIcon
          className={cn("size-3.5", loadoutIndex >= 0 && "fill-current")}
        />
      </button>
      <button
        type="button"
        aria-label={
          favorite ? `Unfavorite ${model.label}` : `Favorite ${model.label}`
        }
        onClick={onFavorite}
        className={cn(
          "mr-1.5 rounded p-1 text-faint transition-opacity duration-150 hover:text-foreground",
          favorite
            ? "text-foreground/70"
            : "opacity-0 group-hover/model:opacity-100 focus:opacity-100"
        )}
      >
        <StarIcon className={cn("size-3.5", favorite && "fill-current")} />
      </button>
    </div>
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
