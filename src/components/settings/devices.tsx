import { useEffect, useState, type ComponentType, type ReactNode } from "react"
import { ArrowUpRightIcon, CheckIcon, CopyIcon, GlobeIcon, LaptopIcon, MonitorSmartphoneIcon, PlusIcon, ServerIcon, TerminalIcon } from "lucide-react"
import { toast } from "sonner"
import {
  codePage,
  CONTAINER_LOGS_COMMAND,
  containerCommand,
  deviceFamily,
  deviceHealth,
  deviceKindWords,
  healthWords,
  HOST_COMMAND,
  joinCommand,
  MACHINE_GUIDE_URL,
  needsMakoUpdate,
  type DeviceFamily,
  type DeviceHealth,
  type DeviceRecord,
  type DeviceRuns,
  type JoinedDevice,
} from "@mako/host/contracts/account-devices"
import { finsWord } from "@mako/host/contracts/agents"
import { Action, Chip, Eyebrow, IconAction, ListCard, ListCardRow, Segmented } from "@/components/ui/kit"
import { Shimmer } from "@/components/ui/shimmer"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { Group } from "@/web-client/settings-rows"

/**
 * Settings › Devices, the one component a Mac's window and the web app both draw: every device of the account, this
 * one first, each with its kind, system, Mako, health and what runs there, and Remove, asked first with what stops.
 * Add a machine opens the lines to run on a machine of one's own, and says so when it joins. It reads nothing itself:
 * whoever shows it hands it the account's devices and how to change them, a Mac from its host and a browser from the
 * gateway. `form` picks the sizes: a window's, or a finger's on a phone or tablet.
 */
export interface DevicesProps {
  form: "desk" | "touch"
  /** Every device of the account; undefined until they're read. */
  devices: readonly DeviceRecord[] | undefined
  /** This device, listed first, and what it's called there: "This Mac", "This browser". */
  current: string | undefined
  currentLabel: string
  /** Whether the account's other devices reach this one, in a few words, when they can't or not yet. */
  currentReach?: string | undefined
  /** When the cloud last heard from each quiet device (its `device-quiet`), where this window hears it. */
  quiet?: ReadonlyMap<string, string>
  /** What runs on each device, as far as this window's list of the account says. */
  runs: ReadonlyMap<string, DeviceRuns>
  /** The device being removed now, and whether anything else of the account is under way. */
  removing: string | undefined
  busy: boolean
  /** Why the last removal failed, or why the devices couldn't be read. */
  failure: string | undefined
  unread: string | undefined
  onRemove(id: string): Promise<boolean>
  /** The account's cloud, as a command names it; undefined where this window can't say. */
  cloud: string | undefined
  /** The device that last joined the account, as its stream said it. */
  joined: JoinedDevice | undefined
  /** Told while Add a machine is open, so its owner says a join there and not twice. */
  onAdding?(adding: boolean): void
  openUrl(url: string): void
  Sheet: ComponentType<MachineSheetProps>
}

/** What holds Add a machine: a dialog in a window, a sheet from the bottom on a phone. It draws the title. */
export interface MachineSheetProps {
  open: boolean
  onDismiss: () => void
  title: string
  children: ReactNode
}

const FAMILY_ICONS = { mac: LaptopIcon, machine: ServerIcon, terminal: TerminalIcon, browser: GlobeIcon, other: MonitorSmartphoneIcon } satisfies Record<DeviceFamily, typeof LaptopIcon>

/** Health reads off a clock: read again as a minute passes, so "Online now" doesn't outlast the device. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function Devices(props: DevicesProps) {
  const { form, devices, current, runs, quiet, failure, unread } = props
  const [confirming, setConfirming] = useState<string>()
  /** Add a machine, open: the join heard last before it opened, and the devices there then. One heard after is what it waits for. */
  const [adding, setAdding] = useState<{ before: number | undefined; known: ReadonlySet<string> }>()
  const now = useMinuteClock()
  const ordered = [...(devices ?? [])].sort((left, right) =>
    left.id === current ? -1 : right.id === current ? 1 : (right.lastSeenAt ?? "").localeCompare(left.lastSeenAt ?? "")
  )
  const add = () => {
    setAdding({ before: props.joined?.at, known: new Set(ordered.map((device) => device.id)) })
    props.onAdding?.(true)
  }
  const dismiss = () => {
    setAdding(undefined)
    props.onAdding?.(false)
  }
  const rows = ordered.map((device) => (
    <DeviceRow
      key={device.id}
      form={form}
      device={device}
      current={device.id === current}
      currentLabel={props.currentLabel}
      reach={device.id === current ? props.currentReach : undefined}
      health={deviceHealth(device, { current: device.id === current, quietSince: quiet?.get(device.id), heard: device.lastSeenAt === undefined && (runs.get(device.id)?.sessions ?? 0) > 0, now })}
      now={now}
      runs={runs.get(device.id)}
      confirming={confirming === device.id}
      removing={props.removing === device.id}
      busy={props.busy}
      onConfirm={(next) => setConfirming(next ? device.id : undefined)}
      onRemove={() => void props.onRemove(device.id).then((removed) => removed && setConfirming(undefined))}
    />
  ))
  const note = failure ? (
    <p role="alert" className={cn("text-negative", form === "desk" ? "bg-negative/8 px-3 py-2 text-ui leading-relaxed ring-1 ring-negative/20 ring-inset" : "px-1 text-label")}>
      {failure}
    </p>
  ) : unread ? (
    <p className="px-1 text-label text-faint">Your devices couldn't be read: {unread}</p>
  ) : (
    <p className="px-1 text-label leading-relaxed text-faint">Removing a device signs it out within seconds, wherever it is.</p>
  )
  const joined = adding && props.joined && props.joined.at !== adding.before && !adding.known.has(props.joined.id) && props.joined.enrolledBy === "device-code" ? props.joined : undefined
  const sheet = (
    <props.Sheet open={adding !== undefined} onDismiss={dismiss} title={joined ? `${joined.name} joined` : "Add a machine"}>
      {joined ? (
        <MachineJoined form={form} device={joined} removing={props.removing === joined.id} onRemove={() => void props.onRemove(joined.id).then((removed) => removed && dismiss())} onDone={dismiss} />
      ) : (
        <AddMachine form={form} cloud={props.cloud} openUrl={props.openUrl} onDone={dismiss} />
      )}
    </props.Sheet>
  )
  if (form === "touch")
    return (
      <div data-testid="account-devices" data-form="touch" className="flex flex-col gap-2">
        <Group title="Devices">
          {rows}
          {devices ? null : <p className="px-4 py-3 text-ui text-faint">Reading your devices…</p>}
          <button type="button" data-add-machine onClick={add} className="web-row flex min-h-12 w-full items-center gap-3 px-4 text-left text-ui">
            <PlusIcon className="size-4 text-muted-foreground" />
            Add a machine
          </button>
        </Group>
        {note}
        {sheet}
      </div>
    )
  return (
    <div data-testid="account-devices" data-form="desk" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow>Devices</Eyebrow>
        <Action size="xs" data-add-machine onClick={add}>
          <PlusIcon />
          Add a machine
        </Action>
      </div>
      <ListCard>
        {rows}
        {devices ? null : (
          <ListCardRow>
            <p className="text-ui text-faint">Reading your devices…</p>
          </ListCardRow>
        )}
      </ListCard>
      {note}
      {sheet}
    </div>
  )
}

/**
 * How a device came to be signed in as you, in one line: when, from where (as the cloud read its address, never the
 * address), and how. "Joined Oct 21 from San Jose, United States, through the browser". Where is left out for a
 * device that joined before the cloud kept it.
 */
function joinedLine(device: DeviceRecord): string | undefined {
  if (!device.createdAt) return undefined
  const at = new Date(device.createdAt)
  const when = at.toLocaleDateString(undefined, { month: "short", day: "numeric", year: at.getFullYear() === new Date().getFullYear() ? undefined : "numeric" })
  const place = placeWords(device.enrolledFrom ?? null)
  const how = device.enrolledBy === undefined ? "" : device.enrolledBy === "browser" ? ", through the browser" : ", with a code you approved"
  return `Joined ${when}${place ? ` from ${place}` : ""}${how}`
}

/** A place as the cloud read it, in words: "Frankfurt, Germany"; empty when it couldn't say. */
function placeWords(from: { city: string | null; country: string | null } | null): string {
  if (!from) return ""
  let country = from.country
  try {
    if (country) country = new Intl.DisplayNames(undefined, { type: "region" }).of(country) ?? country
  } catch {
    // A code the runtime doesn't know is shown as it came.
  }
  return [from.city, country].filter(Boolean).join(", ")
}

/** "2 Sessions · 1 Fin", or nothing where nothing runs there that this window knows of. */
function runsWords(runs: DeviceRuns | undefined): string | undefined {
  if (!runs || (!runs.sessions && !runs.fins)) return undefined
  return [runs.sessions ? `${runs.sessions} Session${runs.sessions === 1 ? "" : "s"}` : undefined, runs.fins ? finsWord(runs.fins) : undefined].filter(Boolean).join(" · ")
}

/**
 * What removing a device stops, said before it's removed: its sign-in at once; its Sessions for every other device,
 * which stay on the device itself; and its Fins' way to their Apex.
 */
function removalWords(device: DeviceRecord, runs: DeviceRuns | undefined): string {
  const parts = [`${device.name} is signed out within seconds and can't be reached until it joins again.`]
  if (runs?.sessions) parts.push(`Its ${runs.sessions === 1 ? "Session leaves" : `${runs.sessions} Sessions leave`} your other devices and ${runs.sessions === 1 ? "stays" : "stay"} on ${device.name}.`)
  if (runs?.fins) parts.push(`Its ${finsWord(runs.fins)} can't report until then.`)
  return parts.join(" ")
}

const HEALTH_DOTS = { online: "bg-positive", quiet: "bg-faint/70", never: "ring-1 ring-faint ring-inset" } satisfies Record<DeviceHealth["state"], string>

function DeviceRow({
  form,
  device,
  current,
  currentLabel,
  reach,
  health,
  now,
  runs,
  confirming,
  removing,
  busy,
  onConfirm,
  onRemove,
}: {
  form: DevicesProps["form"]
  device: DeviceRecord
  current: boolean
  currentLabel: string
  reach: string | undefined
  health: DeviceHealth
  now: number
  runs: DeviceRuns | undefined
  confirming: boolean
  removing: boolean
  busy: boolean
  onConfirm: (confirming: boolean) => void
  onRemove: () => void
}) {
  const family = deviceFamily(device.kind)
  const Icon = FAMILY_ICONS[family]
  const behind = needsMakoUpdate(device.appVersion)
  const joined = joinedLine(device)
  const facts = [deviceKindWords(device), device.platform, device.appVersion ? `Mako ${device.appVersion}` : null].filter(Boolean).join(" · ")
  const standing = [healthWords(health, now), reach, runsWords(runs)].filter(Boolean).join(" · ")
  const touch = form === "touch"
  const body = (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span data-device-name className={cn("truncate text-ui", touch ? "" : "font-medium")}>{device.name}</span>
        {current ? <Chip className="shrink-0 whitespace-nowrap">{currentLabel}</Chip> : null}
        {behind ? (
          <Chip tone="caution" data-device-behind className="shrink-0 whitespace-nowrap" title={`${device.name} runs Mako ${device.appVersion}, older than this Mako works with. Update Mako there.`}>
            Needs Mako's update
          </Chip>
        ) : null}
      </div>
      {confirming ? (
        <p data-device-stops className="mt-0.5 text-label leading-relaxed text-pretty text-caution">{removalWords(device, runs)}</p>
      ) : (
        <>
          <p data-device-facts className={cn("mt-0.5 text-label text-faint", touch ? "text-pretty" : "truncate")} title={facts}>
            {facts}
          </p>
          <p data-device-health={health.state} className="flex min-w-0 items-center gap-1.5 text-label text-faint">
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", HEALTH_DOTS[health.state])} />
            <span className="truncate">{standing}</span>
          </p>
          {joined ? (
            <p data-device-joined className={cn("text-label text-faint", touch ? "text-pretty" : "truncate")} title={joined}>
              {joined}
            </p>
          ) : null}
        </>
      )}
    </div>
  )
  if (touch)
    return (
      <div data-device-row data-device={device.id} data-device-family={family} className="flex flex-col">
        <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
          <span className="shrink-0 text-muted-foreground">
            <Icon className="size-4" />
          </span>
          {body}
          {current || confirming ? null : (
            <button type="button" className="web-quiet-button h-9 shrink-0 px-3" disabled={busy} onClick={() => onConfirm(true)}>
              Remove
            </button>
          )}
        </div>
        {confirming ? (
          <div className="flex justify-end gap-2 px-4 pb-3">
            <button type="button" className="web-quiet-button h-9 px-3" disabled={removing} onClick={() => onConfirm(false)}>
              Cancel
            </button>
            <button type="button" className="web-button web-button-negative h-9 px-3" disabled={removing} onClick={onRemove}>
              {removing ? "Removing…" : "Remove"}
            </button>
          </div>
        ) : null}
      </div>
    )
  return (
    <ListCardRow data-device-row data-device={device.id} data-device-family={family} className="flex items-center gap-3">
      <div className="flex size-8 shrink-0 items-center justify-center bg-fill-hover text-muted-foreground [&_svg]:size-4">
        <Icon />
      </div>
      {body}
      {current ? null : confirming ? (
        <div className="flex shrink-0 animate-enter items-center gap-1">
          <Action size="xs" disabled={removing} onClick={() => onConfirm(false)}>
            Cancel
          </Action>
          <Action size="xs" tone="danger" disabled={removing} onClick={onRemove}>
            {removing ? <Spinner /> : null}
            Remove
          </Action>
        </div>
      ) : (
        <Action size="xs" className="shrink-0" disabled={busy} onClick={() => onConfirm(true)}>
          Remove
        </Action>
      )}
    </ListCardRow>
  )
}

type Way = "host" | "container"

const WAYS: Array<{ value: Way; label: string }> = [
  { value: "host", label: "Mako's host" },
  { value: "container", label: "Docker" },
]

/**
 * The lines to run on a machine of one's own, and what happens after: it prints a page and a code, the person
 * confirms the code on a device that's signed in, and the machine runs as a device. The lines are the guide's
 * (`docs/linux-device.md`), which also says how the host or its image gets onto the machine.
 */
function AddMachine({ form, cloud, openUrl, onDone }: { form: DevicesProps["form"]; cloud: string | undefined; openUrl: (url: string) => void; onDone: () => void }) {
  const [way, setWay] = useState<Way>("host")
  const touch = form === "touch"
  const link = (label: string, url: string) => (
    <button type="button" onClick={() => openUrl(url)} className="pressable inline-flex items-center gap-0.5 text-foreground underline decoration-hairline underline-offset-2">
      {label}
      <ArrowUpRightIcon aria-hidden className="size-3" />
    </button>
  )
  return (
    <div data-add-machine-sheet className={cn("flex flex-col", touch ? "gap-5" : "gap-4")}>
      <p className="text-ui leading-relaxed text-pretty text-muted-foreground">
        A Linux machine of your own joins your account as a device. Your other devices watch and steer its Sessions, and start Threads there.
      </p>
      {touch ? (
        <div role="radiogroup" aria-label="How Mako runs there" className="grid grid-cols-2 gap-1 bg-raised p-1">
          {WAYS.map((each) => (
            <button key={each.value} type="button" role="radio" aria-checked={way === each.value} onClick={() => setWay(each.value)} className={cn("pressable h-9 text-ui", way === each.value ? "bg-fill-selected font-medium text-foreground" : "text-muted-foreground")}>
              {each.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex">
          <Segmented label="How Mako runs there" value={way} options={WAYS} onChange={setWay} />
        </div>
      )}
      <ol className={cn("flex flex-col text-ui", touch ? "gap-5" : "gap-4")}>
        <Step form={form} number={1} title={way === "host" ? "On the machine, join your account" : "On the machine, start the container"}>
          <Command form={form} text={way === "host" ? joinCommand(cloud) : containerCommand(cloud)} label={way === "host" ? "The join line" : "The container's line"} />
          <p className="text-label leading-relaxed text-pretty text-faint">
            {way === "host" ? "mako-host is Mako's host, built on the machine from a checkout. " : "The image is built on the machine from a checkout, and joins on its first start. "}
            {link("How to build it", MACHINE_GUIDE_URL)}
          </p>
        </Step>
        <Step form={form} number={2} title="Confirm the code it prints">
          {way === "container" ? <Command form={form} text={CONTAINER_LOGS_COMMAND} label="The line that shows the code" /> : null}
          <p className="text-label leading-relaxed text-pretty text-faint">
            It prints a page and a code such as BCDF-GHJK, good for 10 minutes. Open the page on any device that's signed in, this one included, and approve it once the code matches.
            {cloud ? <> {link("Open the code page", codePage(cloud))}</> : null}
          </p>
        </Step>
        <Step form={form} number={3} title={way === "host" ? "Run the host" : "It runs as a device"}>
          {way === "host" ? <Command form={form} text={HOST_COMMAND} label="The host's line" /> : null}
          <p className="text-label leading-relaxed text-pretty text-faint">
            {way === "host" ? "It runs as the device it joined as, named by its hostname." : "A new container on the same volume is the same device."} Signing in each agent there is its own step, as on a Mac.
          </p>
        </Step>
      </ol>
      <div className={cn("flex items-center justify-between gap-3", touch ? "pt-1" : "pt-2")}>
        <p role="status" data-machine-waiting className="min-w-0 truncate text-label text-faint">
          <Shimmer text="Waiting for a machine to join" />
        </p>
        {touch ? (
          <button type="button" className="web-quiet-button h-11 shrink-0 px-4" onClick={onDone}>
            Done
          </button>
        ) : (
          <Action tone="outline" className="shrink-0" onClick={onDone}>
            Done
          </Action>
        )}
      </div>
    </div>
  )
}

function Step({ form, number, title, children }: { form: DevicesProps["form"]; number: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className={cn("flex shrink-0 items-center justify-center bg-fill-selected text-label font-semibold text-foreground", form === "touch" ? "size-6" : "size-5")}>
        {number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </li>
  )
}

/** A line to run, set as code, with Copy. A long one scrolls sideways in a window and wraps on a phone: never cut. */
function Command({ form, text, label }: { form: DevicesProps["form"]; text: string; label: string }) {
  const copy = () =>
    void navigator.clipboard.writeText(text.replace(/\\\n\s*/g, "")).then(
      () => toast(`${label} copied`),
      () => toast.error("The line wasn't copied")
    )
  return (
    <div data-machine-command className="flex items-start gap-1 bg-raised">
      <pre className={cn("min-w-0 flex-1 px-3 font-mono text-label leading-relaxed text-foreground", form === "touch" ? "py-3 wrap-anywhere whitespace-pre-wrap" : "overflow-x-auto py-2 [scrollbar-width:none]")}>{text}</pre>
      {form === "touch" ? (
        <button type="button" aria-label={`Copy: ${label}`} onClick={copy} className="pressable flex size-11 shrink-0 items-center justify-center text-muted-foreground">
          <CopyIcon className="size-4" />
        </button>
      ) : (
        <IconAction label="Copy" size="sm" className="m-0.5" onClick={copy}>
          <CopyIcon />
        </IconAction>
      )}
    </div>
  )
}

const JOINED_KIND = { mac: "A Mac", machine: "A machine", terminal: "A terminal", browser: "A browser", other: "A device" } satisfies Record<DeviceFamily, string>

/** The sheet once the machine joined, as the account's stream said it: what joined, from where, and Remove for one that isn't theirs. */
function MachineJoined({ form, device, removing, onRemove, onDone }: { form: DevicesProps["form"]; device: JoinedDevice; removing: boolean; onRemove: () => void; onDone: () => void }) {
  const place = placeWords(device.from)
  const touch = form === "touch"
  return (
    <div data-machine-joined={device.id} className={cn("flex animate-enter flex-col", touch ? "gap-5" : "gap-4")}>
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center bg-positive/12 text-positive">
          <CheckIcon className="size-4" strokeWidth={2.5} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui font-medium">{device.name} is a device of your account</p>
          <p className="text-label leading-relaxed text-pretty text-faint">
            {JOINED_KIND[deviceFamily(device.kind)]} on {device.platform}
            {place ? `, from ${place}` : ""}, with a code you approved. It's in your devices now.
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        {touch ? (
          <>
            <button type="button" className="web-quiet-button h-11 px-3 text-negative" disabled={removing} onClick={onRemove}>
              {removing ? "Removing…" : "Not yours? Remove"}
            </button>
            <button type="button" className="web-button h-11" onClick={onDone}>
              Done
            </button>
          </>
        ) : (
          <>
            <Action tone="danger" disabled={removing} onClick={onRemove}>
              {removing ? <Spinner /> : null}
              Not yours? Remove
            </Action>
            <Action tone="solid" onClick={onDone}>
              Done
            </Action>
          </>
        )}
      </div>
    </div>
  )
}
