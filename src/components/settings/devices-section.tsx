import { useEffect, useMemo } from "react"
import { XIcon } from "lucide-react"
import type { DeviceRuns } from "@mako/host/contracts/account-devices"
import { Devices, type MachineSheetProps } from "@/components/settings/devices"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Action, IconAction } from "@/components/ui/kit"
import { useAcp } from "@/state/acp"
import { cloudAccount, useCloudAccount } from "@/state/cloud-account"
import { desktop } from "@/state/desktop"
import { shallowEqual } from "@/state/store"
import type { CloudAccountState, CloudDevice } from "@/lib/types"

type SignedIn = Extract<CloudAccountState, { status: "signed-in" }>

/** Settings › Devices on a Mac: the account's devices as its host reads them, and adding a machine of one's own. */
export function DevicesSection() {
  const account = useCloudAccount((state) => state.account)
  useEffect(() => cloudAccount.load(), [])
  if (!account) return <p className="text-ui text-faint">Reading your account…</p>
  if (account.state.status !== "signed-in")
    return (
      <div className="flex flex-col items-start gap-3" data-testid="devices-section">
        <p className="max-w-[34rem] text-ui leading-relaxed text-pretty text-muted-foreground">
          Sign in to Mako to see every device of your account here, and to add a machine of your own for Threads to run on.
        </p>
        <Action tone="outline" onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "account" }))}>
          Open Account
        </Action>
      </div>
    )
  return (
    <div className="flex animate-enter flex-col gap-6" data-testid="devices-section">
      <AccountDevices state={account.state} cloud={account.cloud} />
    </div>
  )
}

/** What this window knows of a place from the conversations it holds there. */
interface PlaceReading extends DeviceRuns {
  /** When the account last heard from the device, as its listed conversations say while it's quiet (`quietSince`). */
  quietSince?: number
  /** It lists work the account doesn't call quiet: it's there now. */
  heard: boolean
}

/**
 * What this window knows runs where, by a device's name: the conversations it holds, its own and the ones the
 * account's list named on another device, folded into their Threads, and those with an Apex its Fins; and the
 * account's own word on that device, quiet since a time or there, which the host's listing puts on each. A cloud
 * machine's are nobody's here. Compared by its numbers, so a token streaming somewhere wakes nothing.
 */
function useRunsByPlace(): ReadonlyMap<string, PlaceReading> {
  // A few numbers a place, each under a letter before its name (`t` Threads, `f` Fins, `q` quiet since, `h` heard),
  // so the whole reading compares by its numbers.
  const counts = useAcp((state) => {
    const threads = new Map<string, Set<string>>()
    const counted: Record<string, number> = {}
    for (const conversation of Object.values(state.conversations)) {
      if (conversation.kind !== "live") continue
      const place = conversation.elsewhere ?? ""
      if (conversation.elsewhere !== undefined) {
        if (conversation.quietSince === undefined) counted[`h${place}`] = 1
        else counted[`q${place}`] = Math.max(counted[`q${place}`] ?? 0, conversation.quietSince)
      }
      if (conversation.parent) {
        counted[`f${place}`] = (counted[`f${place}`] ?? 0) + 1
        continue
      }
      const there = threads.get(place) ?? new Set<string>()
      there.add(conversation.threadId ?? conversation.key)
      threads.set(place, there)
    }
    for (const [place, there] of threads) counted[`t${place}`] = there.size
    return counted
  }, shallowEqual)
  return useMemo(() => {
    const places = new Map<string, PlaceReading>()
    for (const [key, count] of Object.entries(counts)) {
      const place = key.slice(1)
      const there = places.get(place) ?? { threads: 0, fins: 0, heard: false }
      const letter = key.charAt(0)
      places.set(place, letter === "f" ? { ...there, fins: count } : letter === "t" ? { ...there, threads: count } : letter === "q" ? { ...there, quietSince: count } : { ...there, heard: true })
    }
    return places
  }, [counts])
}

/** How this Mac's own row says whether the account's other devices reach it (`runtime`, the link they call it by). */
const REACH_WORDS = {
  connected: undefined,
  connecting: "connecting to your other devices",
  offline: "your other devices can't reach it right now",
  off: "your other devices can't reach it",
} satisfies Record<NonNullable<SignedIn["runtime"]>, string | undefined>

function AccountDevices({ state, cloud }: { state: SignedIn; cloud: string | null }) {
  const devices = useCloudAccount((store) => store.devices)
  const failure = useCloudAccount((store) => store.failure)
  const busy = useCloudAccount((store) => store.busy)
  const joined = useCloudAccount((store) => store.joined)
  const { connection, device: current } = state
  useEffect(() => {
    if (connection !== "connected") return
    void cloudAccount.loadDevices()
    const refresh = () => void cloudAccount.loadDevices()
    const timer = setInterval(refresh, 60_000)
    window.addEventListener("focus", refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener("focus", refresh)
    }
  }, [connection])
  useEffect(() => () => cloudAccount.addingMachine(false), [])
  const byPlace = useRunsByPlace()
  const list: CloudDevice[] = devices?.list ?? [current]
  const runs = new Map<string, DeviceRuns>()
  const quiet = new Map<string, string>()
  const heard = new Set<string>()
  for (const device of list) {
    const there = byPlace.get(device.id === current.id ? "" : device.name)
    if (!there) continue
    runs.set(device.id, { threads: there.threads, fins: there.fins })
    // The account's word, as the list's rows carry it: quiet since a time, else there while it lists work.
    if (there.quietSince !== undefined && !there.heard) quiet.set(device.id, new Date(there.quietSince).toISOString())
    else if (there.heard) heard.add(device.id)
  }
  return (
    <Devices
      form="desk"
      devices={list}
      current={current.id}
      currentLabel="This Mac"
      currentReach={state.runtime ? REACH_WORDS[state.runtime] : undefined}
      runs={runs}
      quiet={quiet}
      heard={heard}
      removing={busy?.startsWith("remove:") ? busy.slice("remove:".length) : undefined}
      busy={Boolean(busy)}
      failure={failure?.action.startsWith("remove:") ? { device: failure.action.slice("remove:".length), message: failure.message } : undefined}
      unread={!devices && failure?.action === "devices" ? failure.message : undefined}
      eyebrow={false}
      onRemove={(id) => cloudAccount.removeDevice(id)}
      cloud={cloud ?? undefined}
      joined={joined}
      onAdding={(adding) => cloudAccount.addingMachine(adding)}
      openUrl={(url) => void desktop.openUrl(url)}
      Sheet={MachineDialog}
    />
  )
}

/** Add a machine in a window: a dialog over Settings, closed by its cross, Escape or a click outside. */
function MachineDialog({ open, onDismiss, title, children }: MachineSheetProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss()
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto p-6" data-machine-sheet>
        <header className="mb-4 flex items-center gap-3">
          <DialogTitle className="min-w-0 flex-1 truncate text-title">{title}</DialogTitle>
          <IconAction label="Close" onClick={onDismiss}>
            <XIcon />
          </IconAction>
        </header>
        {children}
      </DialogContent>
    </Dialog>
  )
}
