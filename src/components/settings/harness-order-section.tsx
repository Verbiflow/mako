import { useEffect, useState, type DragEvent, type KeyboardEvent } from "react"
import { toast } from "sonner"
import { GripVerticalIcon } from "lucide-react"
import { Action, Chip, ListCard, Segmented, SettingRow } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import type { CommitAnalysisMode, HarnessProfile } from "@/lib/types"
import { chooseCommitModel, refreshCommitModel, useCommitModelSettings } from "@/state/commit-model"
import { loadHarnessOrder, saveHarnessOrder, useHarnessOrder, useSavedHarnessOrder } from "@/state/harness-order"
import { setPref, usePrefs } from "@/state/prefs"
import { useSetupAgent } from "@/state/project-setup"
import { useProviders } from "@/state/providers"
import { HarnessDefaultPicker } from "./harness-default-picker"
import { ModelConnections } from "./model-connections"
import { UtilityModelPicker } from "./utility-model-picker"

const DRAG_TYPE = "application/x-mako-harness"

const DEPTH_TEXT = {
  fast: "Reads the whole diff in one pass, with low reasoning effort.",
  deep: "Reads the diff with more effort, and the source files where the diff alone is unclear.",
} satisfies Record<CommitAnalysisMode, string>

/**
 * The harnesses in the order Mako tries them when it picks one itself, each
 * with the model it starts on and the work Mako gives it: setting a project
 * up, and drafting commit messages. Drafting's model, its depth and the API
 * keys it can run on instead sit under the list, beside the harnesses they
 * choose between.
 */
export function HarnessOrderSection() {
  useHarnessIdentity()
  const order = useHarnessOrder()
  const custom = useSavedHarnessOrder().length > 0
  const profiles = useProviders((state) => state.profiles)
  const setup = useSetupAgent()?.harness
  const { settings } = useCommitModelSettings()
  const drafter = settings?.work?.commit.resolved
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<number | null>(null)

  useEffect(() => {
    void loadHarnessOrder()
    void refreshCommitModel()
    const focus = () => void refreshCommitModel()
    window.addEventListener("focus", focus)
    return () => window.removeEventListener("focus", focus)
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
  const roles = (harness: string) => [
    setup === harness ? "Setup" : undefined,
    drafter?.kind === "agent" && drafter.source === harness ? "Drafting" : undefined,
  ].filter((role) => role !== undefined)

  return (
    <>
      <section className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h3 className="text-ui font-medium">Harnesses</h3>
            <p className="mt-0.5 text-label text-muted-foreground">
              Each starts new conversations and project setups on the model at the right: Mako's recommendation until
              you pick another, marked with a dot. When Mako picks a harness itself, for a setup or an Automatic draft,
              it takes the first one here you're signed in to. Drag to reorder.
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
      </section>
      <Drafting />
    </>
  )
}

/** What writes a commit message when Generate is pressed, and how hard it reads. */
function Drafting() {
  const { settings, error } = useCommitModelSettings()
  const commit = settings?.work?.commit
  const depth = usePrefs((prefs) => prefs.commitAnalysis)
  const writer = error ?? (!commit ? "Loading models…" : commit.resolved ? `${commit.resolved.label} · ${commit.resolved.via}` : commit.reason)
  return (
    <section aria-label="Drafting" className="flex flex-col gap-3">
      <div>
        <h3 className="text-ui font-medium">Drafting</h3>
        <p className="mt-0.5 text-label text-muted-foreground">
          What writes a commit message from the exact diff when you press Generate. Automatic runs the first harness
          above that can, on its light model and your own subscription. Its instructions are in{" "}
          <button type="button" className="pressable underline decoration-faint/50 underline-offset-2 hover:text-foreground" onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "git" }))}>
            Git
          </button>
          .
        </p>
      </div>
      <ListCard>
        <SettingRow title="Commit messages" description={writer}>
          <UtilityModelPicker state={commit} label="Model that drafts commit messages" className="w-56 max-w-full" onChoose={(choice) => void chooseCommitModel(choice)} />
        </SettingRow>
        <SettingRow title="Depth" description={DEPTH_TEXT[depth]}>
          <Segmented
            label="Drafting depth"
            value={depth}
            options={[{ value: "fast", label: "Fast" }, { value: "deep", label: "Deep" }]}
            onChange={(next) => setPref("commitAnalysis", next)}
          />
        </SettingRow>
      </ListCard>
      <ModelConnections settings={settings} refresh={refreshCommitModel} choose={chooseCommitModel} />
    </section>
  )
}

function HarnessOrderRow({
  harness,
  index,
  profile,
  roles,
  dragging,
  drop,
  onMove,
  ...events
}: {
  harness: string
  index: number
  profile: HarnessProfile | undefined
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
          {roles.map((role) => <Chip key={role}>{role}</Chip>)}
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
