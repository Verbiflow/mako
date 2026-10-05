import { useCallback, useEffect, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react"
import { toast } from "sonner"
import { GripVerticalIcon } from "lucide-react"
import type { SettingValue } from "@mako/sessions/settings"
import { lightDefault } from "../../../electron/contracts/harness-defaults"
import { Action, Chip, ListCard, SettingRow } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { settingValueLabel } from "@/components/composer/settings-source"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { UTILITY_AUTOMATIC, type HarnessModel, type HarnessProfile, type UtilityModelSettings, type UtilityTaskState } from "@/lib/types"
import { refreshCommitModel } from "@/state/commit-model"
import { loadHarnessOrder, saveHarnessOrder, useHarnessOrder, useSavedHarnessOrder } from "@/state/harness-order"
import { utilityModels } from "@/state/model-runtime"
import { useSetupAgent } from "@/state/project-setup"
import { useProviders } from "@/state/providers"
import { HarnessDefaultPicker } from "./harness-default-picker"
import { UtilityModelPicker } from "./utility-model-picker"

const DRAG_TYPE = "application/x-mako-harness"

/**
 * One place for the work Mako hands a harness itself: which harness sets a
 * project up and drafts commit messages, in an order the person drags, and
 * the model commit messages and pull request descriptions run on.
 */
export function HarnessOrderSection() {
  useHarnessIdentity()
  const order = useHarnessOrder()
  const custom = useSavedHarnessOrder().length > 0
  const profiles = useProviders((state) => state.profiles)
  const setup = useSetupAgent()?.harness
  const { settings, error, refresh, choose } = useUtilityWork()
  const work = settings?.work
  const runners = work?.runners ?? []
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<number | null>(null)

  useEffect(() => {
    void loadHarnessOrder()
  }, [])

  const save = (next: string[]) =>
    void saveHarnessOrder(next)
      .then(refresh)
      .catch((caught: Error) => toast.error(caught.message || "The order could not be saved. Try again."))
  const move = (from: number, to: number) => {
    if (from < 0 || to < 0 || to >= order.length || from === to) return
    const next = [...order]
    const [harness] = next.splice(from, 1)
    if (harness === undefined) return
    next.splice(to, 0, harness)
    save(next)
  }

  const automatic = (state: UtilityTaskState | undefined) =>
    state?.choice === UTILITY_AUTOMATIC && state.resolved?.kind === "agent" ? state.resolved.source : undefined
  const roles = (harness: string) =>
    [
      setup === harness ? "Setup" : undefined,
      automatic(work?.commit) === harness ? "Commits" : undefined,
    ].filter((role) => role !== undefined)

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h3 className="text-ui font-medium">Harnesses</h3>
          <p className="mt-0.5 text-label text-muted-foreground">
            Each starts new conversations and project setups on the model at the right: Mako's recommendation until
            you pick another, marked with a dot. When Mako picks a harness itself, it takes the first one here you're
            signed in to. Drag to reorder.
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
            runs={runners.includes(harness)}
            roles={roles(harness)}
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
      <ListCard>
        <TaskRow
          title="Commit messages and pull requests"
          state={work?.commit}
          error={error}
          picker={<UtilityModelPicker state={work?.commit} label="Model that drafts commit messages and pull requests" className="w-56 max-w-full" onChoose={(choice) => void choose("commit", choice)} />}
        />
      </ListCard>
      <p className="text-label text-faint">
        Automatic runs each harness's light model at low reasoning, through the first harness above that can do it, on
        your own subscription.
      </p>
    </section>
  )
}

function HarnessOrderRow({
  harness,
  index,
  profile,
  runs,
  roles,
  dragging,
  drop,
  onMove,
  ...events
}: {
  harness: string
  index: number
  profile: HarnessProfile | undefined
  runs: boolean
  roles: string[]
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
  const light = signedIn && profile ? lightDefault(harness, profile.models, profile.defaultModel) : undefined
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
          {roles.map((role) => (
            <Chip key={role}>{role}</Chip>
          ))}
        </p>
        <p className="text-label text-faint">
          {pending ? (
            "Asking for its models…"
          ) : !signedIn ? (
            "Not signed in"
          ) : (
            <>
              Commits{" "}
              <span className="text-muted-foreground">{light ? summary(light.model, light.options) : "no light model"}</span>
              {light && !runs ? " (not supported yet)" : null}
            </>
          )}
        </p>
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

function TaskRow({
  title,
  state,
  error,
  picker,
}: {
  title: string
  state: UtilityTaskState | undefined
  error: string | null
  picker: ReactNode
}) {
  const description = error
    ? error
    : !state
      ? "Loading models"
      : state.resolved
        ? `${state.resolved.label} · ${state.resolved.via}`
        : state.reason
  return (
    <SettingRow title={title} description={description}>
      {picker}
    </SettingRow>
  )
}

/** A model's name and its reasoning level, as a row reads them: "GPT-6 Luna · Low". */
function summary(model: HarnessModel, options: Readonly<Record<string, SettingValue>> | undefined): string {
  const reasoning = model.options.find((option) => option.role === "reasoning")
  const value = reasoning ? options?.[reasoning.id] : undefined
  return reasoning && value !== undefined ? `${model.label} · ${settingValueLabel(reasoning, value)}` : model.label
}

/** The small-task settings the host reports, refreshed on focus and after a change. */
function useUtilityWork() {
  const [settings, setSettings] = useState<UtilityModelSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      setSettings(await utilityModels.settings())
      setError(null)
      void refreshCommitModel()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Models could not be loaded.")
    }
  }, [])
  useEffect(() => {
    queueMicrotask(() => void refresh())
    const focus = () => void refresh()
    window.addEventListener("focus", focus)
    return () => window.removeEventListener("focus", focus)
  }, [refresh])
  const choose = async (task: "commit", choice: string) => {
    try {
      await utilityModels.choose(task, choice)
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The choice could not be saved. Try again.")
    }
  }
  return { settings, error, refresh, choose }
}
