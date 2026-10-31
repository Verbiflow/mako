import { useEffect, useMemo, useRef, useState } from "react"
import { CheckIcon, ChevronDownIcon, CloudIcon, FolderIcon, LaptopIcon, ShieldIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { MakoMark } from "@/components/ui/mako-mark"
import { modelByIdentity } from "@mako/sessions/settings"
import { startFailure } from "@mako/host/contracts/cloud-threads"
import { errorMessage } from "@mako/host/contracts/error-message"
import type { PromptAttachment } from "@mako/host/contracts/providers-acp"
import { Spinner } from "@/components/ui/spinner"
import { copyAge, formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { titleFromPrompt } from "@/state/acp-start"
import { accessTierInfo } from "@mako/host/contracts/access"
import { accessInEffect, chooseAccess, macLadders, orderedModes, readAccessChoices, type AccessChoices, type AccessInEffect, type Ladder } from "./access"
import { accountProjects, cloudHarnesses, typedRepository } from "./account"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { Composer } from "./composer"
import { newDraftKey } from "./drafts"
import { WebHarnessIcon } from "./harness-icon"
import { webHarnessLabel } from "./labels"
import { CLOUD_PLACE, defaultPlace, macProjects, orderedHarnesses, placeKey, places, readStartMemory, rememberStart, startable, type Place, type PlaceKey, type StartProject } from "./places"
import { Sheet, SheetScroll } from "./sheet"
import { WEB_HARNESSES } from "./labels"
import { addSession, cloudCatalog, macCatalog, macWorktrees, startInCloud, startOnMac, type Catalog, type CloudStep, type OfferedHarness, type Owner, type Started } from "./start"

const CLOUD_ENTITLEMENT = "cloud"
const CLOUD_STEPS = { making: "Making its Thread…", preparing: "Starting a machine…", starting: "Starting the harness…" } satisfies Record<CloudStep, string>

/** A Session added to a Thread that's already running somewhere: its place and folder are the Thread's. */
export interface AddingTo {
  thread: string
  folder: string
  owner: Owner
  /** Where it runs, in words, for the sheet's line. */
  where: string
}

/** A new Thread asked for in one project (a rail folder's +): where it runs and its folder, chosen to begin with. */
export interface StartIn {
  place: PlaceKey
  project: string
}

/** The sheet's chips' own sheets: one open at a time, over the composer. */
type Picking = "place" | "project" | "loadout" | "access" | undefined

/**
 * New: one composer, its keyboard up, and in its card what a start needs, each already chosen: where it runs and the
 * project above the field, the harness and model and the access it runs with (the person's choice for that harness,
 * which their account keeps for every device) in the bar under it, as the desk's composer carries them. So the common
 * start is New, a sentence, Send. Each chip opens its own choices. Adding a Session to a Thread is the same sheet with
 * the Thread's place and project fixed.
 */
export function StartSheet({ open, onDismiss, onStarted, adding }: { open: boolean; onDismiss: () => void; onStarted: (started: Started, where: string) => void; adding?: AddingTo }) {
  return (
    <Sheet open={open} onDismiss={onDismiss} label={adding ? "Add a Session" : "New thread"} className="web-start-sheet">
      {open ? <StartForm onStarted={onStarted} adding={adding} /> : null}
    </Sheet>
  )
}

/** New on a wide screen: the pane beside the list, as the desk's new tab, its composer waiting in the middle. */
export function StartPane({ onDismiss, onStarted }: { onDismiss: () => void; onStarted: (started: Started, where: string) => void }) {
  return (
    <section aria-label="New thread" className="web-start-pane flex min-h-0 flex-1 flex-col bg-surface">
      <header className="web-bar flex shrink-0 items-center gap-1 pr-1.5 pl-5">
        <h1 className="min-w-0 flex-1 truncate text-ui font-semibold">New thread</h1>
        <button type="button" aria-label="Close" onClick={onDismiss} className="web-icon-button">
          <XIcon className="size-[18px]" />
        </button>
      </header>
      <div className="web-start-pane-body web-enter">
        <MakoMark className="mx-auto mb-7 size-8 opacity-30" />
        <StartForm onStarted={onStarted} />
      </div>
    </section>
  )
}

export function StartForm({ onStarted, adding, startIn, desk = false }: { onStarted: (started: Started, where: string) => void; adding?: AddingTo; startIn?: StartIn; desk?: boolean }) {
  const client = useWebClient()
  const list = useAccountList((state) => state)
  const cloud = client.account.entitlements.includes(CLOUD_ENTITLEMENT)
  const memory = useMemo(() => readStartMemory(), [])
  const all = useMemo(() => places(list, cloud), [list, cloud])
  const [chosenPlace, setChosenPlace] = useState<string | undefined>(() => {
    if (adding) return adding.owner.kind === "cloud" ? CLOUD_PLACE : adding.owner.deviceId
    if (startIn) return startIn.place
    const first = defaultPlace(all, memory.place)
    return first ? placeKey(first) : undefined
  })
  const place = all.find((each) => placeKey(each) === chosenPlace) ?? (adding?.owner.kind === "cloud" ? ({ kind: "cloud" } as const) : undefined)
  const key = place ? placeKey(place) : undefined
  const remembered = key ? memory.loadouts[key] : undefined

  const [projects, setProjects] = useState<StartProject[] | undefined>(undefined)
  const [catalog, setCatalog] = useState<Catalog | undefined>(undefined)
  const [pickedProject, setPickedProject] = useState<string | undefined>(startIn?.project)
  const [picked, setPicked] = useState<{ harness: string; model: string | undefined } | undefined>(undefined)
  const [picking, setPicking] = useState<Picking>(undefined)
  // The chip a choice was opened from: wide, its choices grow from it.
  const [chip, setChip] = useState<HTMLElement | null>(null)
  const pick = (which: Exclude<Picking, undefined>) => (from: HTMLElement) => {
    setChip(from)
    setPicking(which)
  }
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // The person's access choices, as the account keeps them; each harness's ladder, as a Mac of theirs declares it.
  const [choices, setChoices] = useState<AccessChoices | undefined>(undefined)
  const [ladders, setLadders] = useState<Record<string, Ladder> | undefined>(undefined)

  useEffect(() => {
    let current = true
    readAccessChoices(client.gateway).then(
      (found) => current && setChoices(found ?? {}),
      () => current && setChoices({})
    )
    return () => {
      current = false
    }
  }, [client])

  // What the place offers, asked of it as the place changes: its projects and its harnesses. What else the effect
  // reads (the list's rows, the Macs) is as it stands when the place is asked; the list changing doesn't ask again.
  const asked = useRef({ place, all, rows: list.rows, adding })
  useEffect(() => {
    asked.current = { place, all, rows: list.rows, adding }
  })
  useEffect(() => {
    const { place: at, all: every, rows, adding: into } = asked.current
    if (!at || !startable(at)) return
    let current = true
    const mac = at.kind === "mac" ? at : every.find((each): each is Extract<Place, { kind: "mac" }> => each.kind === "mac" && startable(each))
    if (mac)
      void macLadders(client.gateway, client.deviceId, mac.deviceId).then(
        (found) => current && setLadders(found),
        () => undefined
      )
    if (at.kind === "mac") void macCatalog(client.gateway, client.deviceId, at.deviceId, into?.folder, (found) => current && setCatalog(found))
    else {
      // The cloud's harnesses, with the models the person's most recent Mac lists for each.
      let macs: Catalog | undefined
      let cloudHarnessList: string[] | undefined
      const tell = () => current && cloudHarnessList && setCatalog(cloudCatalog(cloudHarnessList, macs))
      void cloudHarnesses(client.gateway).then(
        (found) => {
          cloudHarnessList = found.length ? found : [...WEB_HARNESSES]
          tell()
        },
        (error) => current && setFailure(errorMessage({ error }))
      )
      if (mac)
        void macCatalog(client.gateway, client.deviceId, mac.deviceId, undefined, (found) => {
          macs = found
          tell()
        }).catch(() => undefined)
    }
    if (!into) {
      const projectsAsked =
        at.kind === "mac"
          ? macWorktrees(client.gateway, client.deviceId, at.deviceId).then((worktrees) => macProjects(rows, at.deviceId, worktrees), () => macProjects(rows, at.deviceId, undefined))
          : accountProjects(client.gateway).then((found) => found.map((each) => ({ id: each.url, name: each.name, usedAt: Date.parse(each.usedAt) })))
      projectsAsked.then(
        (found) => current && setProjects(found),
        () => current && setProjects([])
      )
    }
    return () => {
      current = false
    }
  }, [key, client])

  // The project and the loadout as they stand: the person's pick, else the one last started there, else the first
  // project and the desk's first harness with its own default model.
  const project = adding?.folder ?? (pickedProject && (projects?.some((each) => each.id === pickedProject) || typedRepository(pickedProject)) ? pickedProject : (projects?.find((each) => each.id === remembered?.project) ?? projects?.[0])?.id)
  const offered = useMemo(() => (catalog ? orderedHarnesses(catalog, list.rows) : []), [catalog, list.rows])
  // The one to start on: the person's pick, else the last started here, else the desk's first; one still being asked
  // there is held rather than passed over, so the chip doesn't change under the person as the answers arrive.
  const usable = offered.filter((each) => each.available || each.pending)
  const preferred = usable.find((each) => each.harness === picked?.harness) ?? usable.find((each) => each.harness === remembered?.harness) ?? usable[0]
  const chosenHarness = preferred?.available ? preferred : undefined
  const harness = chosenHarness?.harness
  const model = chosenHarness
    ? picked?.harness === chosenHarness.harness
      ? picked.model
      : ((remembered?.harness === chosenHarness.harness ? modelByIdentity(chosenHarness.models, remembered.model)?.id : undefined) ?? chosenHarness.defaultModel)
    : undefined
  const modelLabel = chosenHarness ? (modelByIdentity(chosenHarness.models, model)?.label ?? (chosenHarness.models.length ? undefined : "Default model")) : undefined
  const access = harness && choices ? accessInEffect(harness, choices, ladders?.[harness]) : undefined
  const projectName = adding ? adding.folder.split("/").filter(Boolean).at(-1) : (projects?.find((each) => each.id === project)?.name ?? (project ? typedRepository(project)?.url.split("/").slice(-2).join("/") : undefined))
  const ready = place !== undefined && startable(place) && project !== undefined && harness !== undefined && status === undefined

  const start = async (text: string, attachments: PromptAttachment[]): Promise<boolean> => {
    if (!place || !project || !harness) return false
    if (!text && !attachments.length) return false
    setFailure(undefined)
    const message = { text, attachments, title: titleFromPrompt(text || attachments[0]?.name || "New thread") }
    try {
      let started: Started
      if (adding) {
        setStatus(`Starting ${webHarnessLabel(harness)} in this Thread…`)
        started = await addSession(client.gateway, client.deviceId, adding.owner, { thread: adding.thread, folder: adding.folder, harness, model, mode: access?.mode, message })
      } else if (place.kind === "mac") {
        setStatus(`Starting on ${place.name}…`)
        started = await startOnMac(client.gateway, client.deviceId, place.deviceId, { folder: project, harness, model, mode: access?.mode, message })
      } else {
        const repository = typedRepository(project)
        if (!repository) throw new Error("That isn't a GitHub repository: owner/repository")
        started = await startInCloud(client.gateway, client.deviceId, { repository, harness, model, mode: access?.mode, message }, (step) => setStatus(CLOUD_STEPS[step]))
      }
      if (!adding) rememberStart(placeKey(place), { project, harness, model })
      setStatus(undefined)
      onStarted(started, adding ? adding.where : place.kind === "cloud" ? "the cloud" : place.name)
      return true
    } catch (error) {
      setStatus(undefined)
      setFailure(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  // Where, above the field: the place and its project, fixed when adding to a Thread.
  const where = (
    <div className="web-where" role="group" aria-label="Where it starts">
      <Chip label="Where it runs" disabled={Boolean(adding)} onClick={pick("place")}>
        {place?.kind === "cloud" ? <CloudIcon className="size-3.5" /> : <LaptopIcon className="size-3.5" />}
        <span>{adding ? adding.where : place ? (place.kind === "cloud" ? "Cloud" : place.name) : "Choose"}</span>
      </Chip>
      <span aria-hidden className="text-label text-faint/60">/</span>
      <Chip label="Project" disabled={Boolean(adding)} onClick={pick("project")}>
        <FolderIcon className="size-3.5" />
        {projectName ? <span>{projectName}</span> : projects === undefined && place && startable(place) ? <span className="skeleton h-3 w-12 rounded" /> : <span>Choose</span>}
      </Chip>
    </div>
  )
  // With what, in the bar under it: the model gives way first; the access a start runs with is always in view.
  const how = (
    <>
      <Chip label="Harness and model" onClick={pick("loadout")} shrinks>
        {preferred ? <WebHarnessIcon harness={preferred.harness} className="size-3.5" /> : null}
        {chosenHarness ? <span>{modelLabel ?? webHarnessLabel(chosenHarness.harness)}</span> : preferred?.pending || !catalog ? <span className="skeleton h-3 w-16 rounded" /> : <span>Choose</span>}
      </Chip>
      <Chip label={access ? `Access: ${access.label}` : "Access"} disabled={!harness} onClick={pick("access")}>
        {access?.tier === "full" ? <TriangleAlertIcon className="size-3.5 text-caution" /> : <ShieldIcon className="size-3.5" />}
        {access ? <span>{access.label}</span> : <span className="skeleton h-3 w-14 rounded" />}
      </Chip>
    </>
  )

  return (
    <div className="web-start-form flex min-h-0 flex-col">
      <h2 className="sr-only">{adding ? "Add a Session" : "New thread"}</h2>
      {status ? (
        <p role="status" className="web-start-line flex items-center gap-2 text-label text-muted-foreground">
          <Spinner aria-hidden className="size-3.5" />
          {status}
        </p>
      ) : failure ? (
        <StartFailed message={failure} />
      ) : null}
      <Composer autoFocus placeholder="What should it work on?" header={where} tools={how} sendable={ready} onSend={start} sendLabel="Start" desk={desk} draftKey={newDraftKey(client.account.id, adding ? `add:${adding.thread}` : "thread")} />
      <PlaceSheet anchor={chip} open={picking === "place"} onDismiss={() => setPicking(undefined)} all={all} chosen={chosenPlace} onPick={(next) => {
        if (next !== chosenPlace) {
          setProjects(undefined)
          setCatalog(undefined)
          setPickedProject(undefined)
        }
        setChosenPlace(next)
        setPicking(undefined)
      }} />
      <ProjectSheet anchor={chip} open={picking === "project"} onDismiss={() => setPicking(undefined)} place={place} projects={projects} chosen={project} onPick={(next) => {
        setPickedProject(next)
        setPicking(undefined)
      }} />
      <AccessSheet
        anchor={chip}
        open={picking === "access"}
        onDismiss={() => setPicking(undefined)}
        harness={harness}
        ladder={harness ? ladders?.[harness] : undefined}
        access={access}
        onPick={async (mode) => {
          if (!harness) return
          const before = choices
          setChoices({ ...choices, [harness]: mode.access ? { mode: mode.id, access: mode.access } : { mode: mode.id } })
          setPicking(undefined)
          try {
            setChoices(await chooseAccess(client.gateway, harness, mode))
          } catch (error) {
            setChoices(before)
            setFailure(`Access wasn't changed: ${errorMessage({ error })}`)
          }
        }}
      />
      <LoadoutSheet anchor={chip} open={picking === "loadout"} onDismiss={() => setPicking(undefined)} offered={offered} harness={preferred?.harness} model={model} onPick={(nextHarness, nextModel) => {
        setPicked({ harness: nextHarness, model: nextModel })
        setPicking(undefined)
      }} />
    </div>
  )
}

/**
 * Why a start didn't go, in its own words; with the GitHub page that gives Mako's GitHub App access to the repository
 * beside them when that's what it lacks, as the turn-on card offers it, so the person can fix it and start again.
 */
function StartFailed({ message }: { message: string }) {
  const { said, install } = startFailure(message)
  return (
    <div role="alert" className="web-start-line flex items-start gap-3">
      <p className="min-w-0 flex-1 text-label text-pretty text-negative">{said}</p>
      {install ? (
        <a href={install} target="_blank" rel="noopener noreferrer" className="web-button h-8 shrink-0 px-3 text-label" data-start-fix="give-access">
          Give access
        </a>
      ) : null}
    </div>
  )
}

/** A choice a start is made with, as the desk's composer shows one: its glyph, its value, and a chevron while it can change. */
function Chip({ label, disabled, onClick, children, shrinks }: { label: string; disabled?: boolean; onClick: (chip: HTMLElement) => void; children: React.ReactNode; shrinks?: boolean }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={(event) => onClick(event.currentTarget)} className={cn("web-chip", shrinks && "web-chip-shrinks")}>
      <span className="flex min-w-0 items-center gap-1.5 [&>span:last-child]:truncate">{children}</span>
      {disabled ? null : <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-50" />}
    </button>
  )
}

function Choice({ chosen, disabled, onClick, children, detail }: { chosen: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode; detail?: string }) {
  return (
    <button type="button" aria-pressed={chosen} disabled={disabled} onClick={onClick} className="web-choice">
      <span className="flex min-w-0 flex-1 items-center gap-3">{children}</span>
      {detail ? <span className="shrink-0 text-label text-faint">{detail}</span> : null}
      <CheckIcon aria-hidden className={cn("size-4 shrink-0 text-foreground", !chosen && "invisible")} />
    </button>
  )
}

function PlaceSheet({ anchor, open, onDismiss, all, chosen, onPick }: { anchor: HTMLElement | null; open: boolean; onDismiss: () => void; all: Place[]; chosen: string | undefined; onPick: (place: string) => void }) {
  return (
    <Sheet open={open} onDismiss={onDismiss} label="Where it runs" anchor={anchor}>
      <h3 className="web-sheet-title">Where it runs</h3>
      <SheetScroll className="flex flex-col px-2 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        {all.length === 0 ? <p className="px-3 py-4 text-ui text-muted-foreground">No Mac is signed in to this account yet, and the cloud isn't on for it.</p> : null}
        {all.map((place) => (
          <Choice key={placeKey(place)} chosen={chosen === placeKey(place)} disabled={!startable(place)} onClick={() => onPick(placeKey(place))} detail={place.kind === "mac" && place.quietSince ? `Off · ${copyAge(Date.parse(place.quietSince))}` : undefined}>
            {place.kind === "cloud" ? <CloudIcon className="size-[18px] text-muted-foreground" /> : <LaptopIcon className="size-[18px] text-muted-foreground" />}
            <span className="truncate">{place.kind === "cloud" ? "Cloud" : place.name}</span>
          </Choice>
        ))}
      </SheetScroll>
    </Sheet>
  )
}

function ProjectSheet({ anchor, open, onDismiss, place, projects, chosen, onPick }: { anchor: HTMLElement | null; open: boolean; onDismiss: () => void; place: Place | undefined; projects: StartProject[] | undefined; chosen: string | undefined; onPick: (project: string) => void }) {
  const [typed, setTyped] = useState("")
  const repository = typed.trim() ? typedRepository(typed) : undefined
  return (
    <Sheet open={open} onDismiss={onDismiss} label="Project" tall anchor={anchor}>
      <h3 className="web-sheet-title">Project</h3>
      <SheetScroll className="flex flex-col px-2 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        {projects === undefined ? (
          <span className="mx-3 my-2 flex items-center gap-2 text-ui text-muted-foreground">
            <Spinner className="size-3.5" />
            Reading its projects…
          </span>
        ) : projects.length === 0 && place?.kind === "mac" ? (
          <p className="px-3 py-4 text-ui text-muted-foreground">No project on {place.name} has a Thread yet. Start one there first, and it's offered here after.</p>
        ) : null}
        {projects?.map((each) => (
          <Choice key={each.id} chosen={chosen === each.id} onClick={() => onPick(each.id)} detail={each.usedAt ? formatRelative(each.usedAt) : undefined}>
            <FolderIcon className="size-[18px] text-muted-foreground" />
            <span className="truncate">{each.name}</span>
          </Choice>
        ))}
        {place?.kind === "cloud" ? (
          <form
            className="flex gap-2 px-2 pt-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (repository) onPick(repository.url)
            }}
          >
            <input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="owner/repository" aria-label="Another GitHub repository" autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url" className={cn("web-field", typed.trim() && !repository && "ring-negative/60")} />
            <button type="submit" disabled={!repository} className="web-button shrink-0">
              Use
            </button>
          </form>
        ) : null}
      </SheetScroll>
    </Sheet>
  )
}

function LoadoutSheet({ anchor, open, onDismiss, offered, harness, model, onPick }: { anchor: HTMLElement | null; open: boolean; onDismiss: () => void; offered: OfferedHarness[]; harness: string | undefined; model: string | undefined; onPick: (harness: string, model: string | undefined) => void }) {
  // The harness whose models are shown: the chosen one until another is tapped, and again each time it opens.
  const [tapped, setTapped] = useState<string | undefined>(undefined)
  const shown = tapped ?? harness
  const current = offered.find((each) => each.harness === shown)
  const close = () => {
    setTapped(undefined)
    onDismiss()
  }
  const pick = (next: string, nextModel: string | undefined) => {
    setTapped(undefined)
    onPick(next, nextModel)
  }
  return (
    <Sheet open={open} onDismiss={close} label="Harness and model" tall anchor={anchor}>
      <h3 className="web-sheet-title">Harness and model</h3>
      <div className="web-scroll web-fade-x flex shrink-0 gap-1.5 overflow-x-auto px-4 pb-3" role="tablist" aria-label="Harness">
        {offered.map((each) => (
          <button key={each.harness} type="button" role="tab" aria-selected={each.harness === shown} disabled={!each.available && !each.pending} onClick={() => (each.models.length ? setTapped(each.harness) : pick(each.harness, undefined))} className="web-chip web-chip-tab">
            <WebHarnessIcon harness={each.harness} className="size-4" />
            {webHarnessLabel(each.harness)}
          </button>
        ))}
      </div>
      <SheetScroll className="flex flex-col px-2 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        {current && !current.available ? <p className="px-3 py-2 text-ui text-muted-foreground">{current.pending ? "Still checking this harness there…" : (current.error ?? "Not signed in there.")}</p> : null}
        {current?.available
          ? current.models.map((each) => (
              <Choice key={each.id} chosen={current.harness === harness && (model ?? current.defaultModel) === each.id} onClick={() => pick(current.harness, each.id)} detail={each.id === current.defaultModel ? "Default" : undefined}>
                <span className="truncate">{each.label}</span>
              </Choice>
            ))
          : null}
        {current?.available && current.models.length === 0 ? (
          <Choice chosen={current.harness === harness} onClick={() => pick(current.harness, undefined)}>
            <span className="truncate">Its default model</span>
          </Choice>
        ) : null}
      </SheetScroll>
    </Sheet>
  )
}

/**
 * The access a new session of the chosen harness runs with, as its ladder lists it: a pick is the person's choice for
 * that harness on every device, the desk's composer included. Without a Mac to list the ladder, it says what's in
 * effect and where to change it.
 */
function AccessSheet({ anchor, open, onDismiss, harness, ladder, access, onPick }: { anchor: HTMLElement | null; open: boolean; onDismiss: () => void; harness: string | undefined; ladder: Ladder | undefined; access: AccessInEffect | undefined; onPick: (mode: Ladder["modes"][number]) => void }) {
  const name = harness ? webHarnessLabel(harness) : "this harness"
  return (
    <Sheet open={open} onDismiss={onDismiss} label="Access" anchor={anchor}>
      <h3 className="web-sheet-title pb-0">Access</h3>
      <p className="web-sheet-note">Every new {name} session starts with it, on any of your devices.</p>
      <SheetScroll className="flex flex-col px-2 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        {ladder ? (
          orderedModes(ladder.modes).map((mode) => (
            <Choice key={mode.id} chosen={access?.mode === mode.id} onClick={() => onPick(mode)} detail={mode.access && mode.name !== accessTierInfo(mode.access).label ? mode.name : undefined}>
              {mode.access === "full" ? <TriangleAlertIcon className="size-[18px] shrink-0 text-caution" /> : <ShieldIcon className="size-[18px] shrink-0 text-muted-foreground" />}
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{mode.access ? (mode.access === "plan" ? "Read-only" : accessTierInfo(mode.access).label) : mode.name}</span>
                {mode.access ? <span className="truncate text-label text-faint">{accessTierInfo(mode.access).summary}</span> : null}
              </span>
            </Choice>
          ))
        ) : (
          <p className="px-3 py-2 text-ui text-muted-foreground">
            {access ? `${access.label} now. ` : ""}To change it here, turn on one of your Macs with Mako: it lists what {name} offers.
          </p>
        )}
      </SheetScroll>
    </Sheet>
  )
}
