import { useEffect, useState, type DragEvent, type KeyboardEvent } from "react"
import { toast } from "sonner"
import { GripVerticalIcon } from "lucide-react"
import { Action, Chip, ListCard } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import type { HarnessProfile } from "@/lib/types"
import { refreshCommitModel } from "@/state/commit-model"
import { loadHarnessOrder, saveHarnessOrder, useHarnessOrder, useSavedHarnessOrder } from "@/state/harness-order"
import { useSetupAgent } from "@/state/project-setup"
import { useProviders } from "@/state/providers"
import { HarnessDefaultPicker } from "./harness-default-picker"

const DRAG_TYPE = "application/x-mako-harness"

/**
 * The harnesses in the order Mako tries them when it picks one itself, for a
 * project setup or an Automatic draft, each with the model it starts on. The
 * drafting model itself is set in Settings › Git.
 */
export function HarnessOrderSection() {
  useHarnessIdentity()
  const order = useHarnessOrder()
  const custom = useSavedHarnessOrder().length > 0
  const profiles = useProviders((state) => state.profiles)
  const setup = useSetupAgent()?.harness
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<number | null>(null)

  useEffect(() => {
    void loadHarnessOrder()
  }, [])

  const save = (next: string[]) =>
    void saveHarnessOrder(next)
      .then(() => refreshCommitModel())
      .catch((caught: Error) => toast.error(caught.message || "The order could not be saved. Try again."))
  const move = (from: number, to: number) => {
    if (from < 0 || to < 0 || to >= order.length || from === to) return
    const next = [...order]
    const [harness] = next.splice(from, 1)
    if (harness === undefined) return
    next.splice(to, 0, harness)
    save(next)
  }


  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h3 className="text-ui font-medium">Harnesses</h3>
          <p className="mt-0.5 text-label text-muted-foreground">
            Each starts new conversations and project setups on the model at the right: Mako's recommendation until
            you pick another, marked with a dot. When Mako picks a harness itself, for a setup or an Automatic commit
            draft, it takes the first one here you're signed in to. Drag to reorder.
          </p>
        </div>
        {custom ? (
          <Action size="xs" onClick={() => save([])}>
            Reset
          </Action>
        ) : null}
      </div>
      <ListCard className="px-1.5 py-1.5">
        <div role="list" aria-label="Harness order">
        {order.map((harness, index) => (
          <HarnessOrderRow
            key={harness}
            harness={harness}
            index={index}
            profile={profiles[harness]}
            setup={setup === harness}
            dragging={dragging === harness}
            drop={over === index && dragging !== null && dragging !== harness ? (order.indexOf(dragging) > index ? "above" : "below") : undefined}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move"
              event.dataTransfer.setData(DRAG_TYPE, harness)
              setDragging(harness)
            }}
            onDragEnd={() => {
              setDragging(null)
              setOver(null)
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = "move"
              setOver(index)
            }}
            onDrop={(event) => {
              event.preventDefault()
              setOver(null)
              setDragging(null)
              move(order.indexOf(event.dataTransfer.getData(DRAG_TYPE)), index)
            }}
            onMove={(by) => move(index, index + by)}
          />
        ))}
        </div>
      </ListCard>
    </section>
  )
}

function HarnessOrderRow({
  harness,
  index,
  profile,
  setup,
  dragging,
  drop,
  onMove,
  ...events
}: {
  harness: string
  index: number
  profile: HarnessProfile | undefined
  setup: boolean
  dragging: boolean
  drop: "above" | "below" | undefined
  onMove(by: number): void
  onDragStart(event: DragEvent): void
  onDragEnd(): void
  onDragOver(event: DragEvent): void
  onDrop(event: DragEvent): void
}) {
  const signedIn = Boolean(profile?.available)
  const pending = !profile || Boolean(profile.pending && !profile.available)
  const keys = (event: KeyboardEvent) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
    event.preventDefault()
    onMove(event.key === "ArrowUp" ? -1 : 1)
  }
  return (
    <div
      role="listitem"
      tabIndex={0}
      draggable
      aria-label={`${harnessLabel(harness)}, ${index + 1} in order. Option and arrow keys move it.`}
      onKeyDown={keys}
      {...events}
      className={cn(
        "group/row relative flex cursor-grab items-center gap-3 rounded-md px-2.5 py-2.5 outline-none active:cursor-grabbing",
        "transition-[background-color,opacity] duration-150 hover:bg-fill-hover focus-visible:bg-fill-hover",
        dragging && "opacity-40",
        !signedIn && !pending && "text-muted-foreground"
      )}
    >
      {drop ? (
        <span
          aria-hidden
          className={cn("pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-foreground/50", drop === "above" ? "-top-px" : "-bottom-px")}
        />
      ) : null}
      <GripVerticalIcon className="size-3.5 shrink-0 text-faint opacity-60 transition-opacity duration-150 group-hover/row:opacity-100" />
      <span className="w-4 shrink-0 text-right text-label text-faint tabular">{index + 1}</span>
      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md bg-raised [box-shadow:inset_0_0_0_0.5px_var(--hairline)]", !signedIn && !pending && "opacity-50")}>
        <HarnessIcon harness={harness} className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-ui font-medium">
          {harnessLabel(harness)}
          {setup ? <Chip>Setup</Chip> : null}
        </p>
        {pending || !signedIn ? <p className="text-label text-faint">{pending ? "Asking for its models…" : "Not signed in"}</p> : null}
      </div>
      {signedIn && profile ? (
        <HarnessDefaultPicker harness={harness} profile={profile} />
      ) : !pending ? (
        <Action size="xs" onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "agents" }))}>
          Sign in
        </Action>
      ) : null}
    </div>
  )
}
