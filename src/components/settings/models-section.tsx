import { useHarnessIdentity } from "@/lib/harness-label"
import { useEffect, useState, type DragEvent } from "react"
import { z } from "zod"
import { XIcon } from "lucide-react"
import { Keys } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import type { HarnessModel } from "@/lib/types"
import { HarnessOrderSection } from "./harness-order-section"
import {
  LOADOUT_LIMIT,
  placeInLoadout,
  removeFromLoadout,
  type LoadoutEntry,
} from "@/state/model-loadout"
import { usePrefs } from "@/state/prefs"
import { providers, useProviders } from "@/state/providers"

const DRAG_TYPE = "application/x-mako-loadout"

/**
 * Models: the loadout the composer's picker opens on and ⌃⌘1–5 reach, and
 * each harness with what it starts a new conversation on.
 */
export function ModelsSection() {
  useEffect(() => {
    void providers.loadAll()
  }, [])
  return (
    <>
      <LoadoutSlots />
      <HarnessOrderSection />
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
          The models the composer's picker lists first, a chord away. Drag to reorder. Pin a model from a harness's
          menu below, or from the composer's picker.
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
                "flex h-[5.5rem] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-label text-faint transition-colors duration-150",
                target ? "border-foreground/40 bg-fill-hover text-muted-foreground" : "border-border"
              )}
            >
              {index === loadout.length ? "Pin a model" : "Empty"}
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
  useHarnessIdentity()
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
        "group/tile relative flex h-[5.5rem] cursor-grab flex-col justify-between rounded-lg bg-shell/55 p-3 active:cursor-grabbing",
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
