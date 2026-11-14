import { useState } from "react"
import { ArrowUpRightIcon, PlusIcon, RefreshCwIcon } from "lucide-react"
import { SETUP_ADDITIONS, threadPlace, viewAsks, type SetupPlaceView, type SetupView } from "@mako/host/contracts/setup"
import { Action, Chip, Segmented } from "@/components/ui/kit"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu"
import { Shimmer } from "@/components/ui/shimmer"
import { cn } from "@/lib/utils"
import { openAppSetup } from "@/state/app-setup"
import { addTo, choosePlace, rebuildBase, shownPlace, threadPlaceId, useSetup } from "@/state/setup"
import { useSetupView } from "./use-setup-view"
import { NeedsYou, PartRows, PartSummaryRow, PlaceIcon, SetupAwayNote, SetupPlaceBody, SetupReadFailed } from "./setup-parts"

/** The clock rows' ages are read against: the page's own read, so a row says the same until the page reads again. */
function readAt(view: SetupView): number {
  return view.at
}

/** One Add for the place: each row starts the same as a part's own +. */
function AddMenu({ folder, place, open }: { folder: string; place: SetupPlaceView; open?: boolean }) {
  return (
    <Menu {...(open && { defaultOpen: true })}>
      <MenuTrigger asChild>
        <Action tone="outline" size="sm" data-setup-add>
          <PlusIcon />
          Add
        </Action>
      </MenuTrigger>
      <MenuContent align="end" className="w-[340px]">
        <MenuLabel>Add to {place.place.kind === "cloud" ? "the cloud's" : `${place.title}'s`} setup</MenuLabel>
        {SETUP_ADDITIONS.map((addition) => (
          <MenuItem key={addition.part} data-setup-addition={addition.part} onSelect={() => addTo(folder, addition.part, place)} className="items-start py-2">
            <span className="flex flex-col">
              <span className="text-ui text-foreground">{addition.title}</span>
              <span className="text-label text-muted-foreground">{addition.detail}</span>
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}

function PlacePicker({ folder, view, current, short }: { folder: string; view: SetupView; current: SetupPlaceView; short?: boolean }) {
  return (
    <Segmented
      label="Place"
      value={current.id}
      options={view.places.map((place) => ({ value: place.id, label: short && place.place.kind === "device" && place.place.platform === "mac" && place.place.here ? "This Mac" : place.title }))}
      onChange={(next) => choosePlace(folder, next)}
    />
  )
}

function PlaceHeader({ folder, place, away }: { folder: string; place: SetupPlaceView; away: boolean }) {
  const busy = useSetup((state) => Boolean(state.busy.rebuild))
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-ui font-semibold text-foreground">
          <PlaceIcon place={place.place} className="size-4 text-faint" />
          {place.title}
        </div>
        <p className="mt-1 max-w-[46rem] text-label leading-relaxed text-muted-foreground">{place.line}</p>
      </div>
      {place.place.kind === "cloud" && !away ? (
        <Action tone="quiet" size="sm" disabled={busy} onClick={() => rebuildBase(folder)}>
          <RefreshCwIcon />
          Rebuild base
        </Action>
      ) : null}
    </div>
  )
}

/** Settings › Apps › a project › Setup: what each place has for the project, a place at a time. */
export function SetupPage({ folder, addOpen }: { folder: string; addOpen?: boolean }) {
  const { view, failed } = useSetupView(folder)
  const picked = useSetup((state) => state.place[folder])
  const place = shownPlace(view, picked)
  if (!view || !place)
    return failed ? <SetupReadFailed folder={folder} why={failed} /> : <p className="text-ui text-faint"><Shimmer text="Reading what each place has…" /></p>
  const now = readAt(view)
  return (
    <div data-setup-page={place.id} className="flex flex-col gap-7">
      <div className="flex items-center gap-3">
        <p data-setup-intro className="min-w-0 flex-1 text-label text-faint">What each place has for {view.project}, and where each thing stands.</p>
        <PlacePicker folder={folder} view={view} current={place} />
        {view.away ? null : <AddMenu folder={folder} place={place} open={addOpen} />}
      </div>
      {view.away ? <SetupAwayNote className="-mt-4" /> : null}
      <PlaceHeader folder={folder} place={place} away={Boolean(view.away)} />
      <SetupPlaceBody folder={folder} view={place} now={now} />
      <p className="px-1 text-label text-faint">Agents see names, never a value. A change reaches running Threads within a minute; a copy refreshes at a Thread&apos;s next turn.</p>
    </div>
  )
}

/**
 * A Thread's own place, in its side panel: its asks first, then what its place has, compact. "All of" opens the
 * project's whole page: in the app's Settings, or where `onAll` says.
 */
export function ThreadSetup({ folder, thread, elsewhere, onAll }: { folder: string | undefined; thread: string | undefined; elsewhere: string | undefined; onAll?: (project: string) => void }) {
  const { view, failed } = useSetupView(folder)
  if (!folder) return <p className="px-4 py-3 text-label text-faint">Open a Thread to see what its place has.</p>
  if (!view) return failed ? <SetupReadFailed folder={folder} why={failed} className="px-4 py-3" /> : <p className="px-4 py-3 text-label text-faint"><Shimmer text="Reading this Thread's setup…" /></p>
  const id = threadPlaceId(view, elsewhere)
  const place = id ? (thread ? threadPlace(view, id, thread) : view.places.find((entry) => entry.id === id)) : undefined
  if (!place) return <p className="px-4 py-3 text-label text-faint">This Thread&apos;s place has no setup to show.</p>
  return (
    <div data-setup-panel={place.id} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
        <Chip className="gap-1.5">
          <PlaceIcon place={place.place} className="size-3" />
          {place.place.kind === "cloud" ? "This Thread's cloud machine" : place.title}
        </Chip>
        <span className="flex-1" />
        <Action size="xs" className="text-faint" onClick={() => (onAll ? onAll(view.root) : openAppSetup(view.root, "setup"))}>
          All of {view.project}
          <ArrowUpRightIcon />
        </Action>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {view.away ? <SetupAwayNote className="pt-1" /> : null}
        <div className="flex flex-col gap-5 pt-2">
          <SetupPlaceBody folder={folder} view={place} now={readAt(view)} compact />
        </div>
      </div>
    </div>
  )
}

/** The phone's page under the project: asks first, then one line per part, each opening to its rows. */
export function PhoneSetup({ folder }: { folder: string }) {
  const { view, failed } = useSetupView(folder)
  const picked = useSetup((state) => state.place[folder])
  const place = shownPlace(view, picked)
  const [open, setOpen] = useState<string | undefined>(undefined)
  if (!view || !place) return failed ? <SetupReadFailed folder={folder} why={failed} className="px-5 py-4" /> : <p className="px-5 py-4 text-ui text-faint"><Shimmer text="Reading…" /></p>
  const now = readAt(view)
  const waiting = viewAsks(view).length
  return (
    <div data-setup-phone={place.id} className="flex flex-col">
      <div className="flex items-center gap-2 px-5 pt-4 pb-2">
        <h1 className="min-w-0 flex-1 truncate text-title font-semibold">{view.project}</h1>
        {waiting ? <Chip tone="attention">{waiting} need you</Chip> : null}
      </div>
      <div className="px-4 pb-3">
        <PlacePicker folder={folder} view={view} current={place} short />
        <p className="mt-2 px-1 text-label leading-relaxed text-muted-foreground">{place.line}</p>
        {view.away ? <SetupAwayNote className="mt-1 px-1" /> : null}
      </div>
      <div className="flex flex-col gap-6 px-4 pb-10">
        <NeedsYou folder={folder} asks={place.asks} now={now} compact />
        <section className="flex flex-col gap-1.5">
          <div className="flex h-6 items-center px-1 text-label font-medium text-faint">{place.title}</div>
          <div className="flex flex-col divide-y divide-hairline bg-shell/55">
            {place.parts.map((part) => (
              <div key={part.part} className={cn(open === part.part && "bg-surface/40")}>
                <PartSummaryRow part={part} now={now} away={Boolean(view.away)} open={open === part.part} onToggle={() => setOpen(open === part.part ? undefined : part.part)} />
                {open === part.part && part.rows.length ? <PartRows folder={folder} view={place} part={part} now={now} /> : null}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
