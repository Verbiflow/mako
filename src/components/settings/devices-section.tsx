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

/**
 * What this window knows runs where, by a device's name: the conversations it holds, its own and the ones the
 * account's list named on another device, each a Session, and those with an Apex its Fins. A cloud machine's are
 * nobody's here. Compared by its counts, so a token streaming somewhere wakes nothing.
 */
function useRunsByPlace(): ReadonlyMap<string, DeviceRuns> {
  // Two counts a place, under `s` and `f` before its name, so the whole reading compares by its numbers.
  const counts = useAcp((state) => {
    const counted: Record<string, number> = {}
    for (const conversation of Object.values(state.conversations)) {
      if (conversation.kind !== "live") continue
      const key = `${conversation.parent ? "f" : "s"}${conversation.elsewhere ?? ""}`
      counted[key] = (counted[key] ?? 0) + 1
    }
    return counted
  }, shallowEqual)
  return useMemo(() => {
    const runs = new Map<string, DeviceRuns>()
    for (const [key, count] of Object.entries(counts)) {
      const place = key.slice(1)
      const there = runs.get(place) ?? { sessions: 0, fins: 0 }
      runs.set(place, key.startsWith("f") ? { ...there, fins: count } : { ...there, sessions: count })
    }
    return runs
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
  for (const device of list) {
    const there = byPlace.get(device.id === current.id ? "" : device.name)
    if (there) runs.set(device.id, there)
  }
  return (
    <Devices
      form="desk"
      devices={list}
      current={current.id}
      currentLabel="This Mac"
      currentReach={state.runtime ? REACH_WORDS[state.runtime] : undefined}
      runs={runs}
      removing={busy?.startsWith("remove:") ? busy.slice("remove:".length) : undefined}
      busy={Boolean(busy)}
      failure={failure?.action.startsWith("remove:") ? failure.message : undefined}
      unread={!devices && failure?.action === "devices" ? failure.message : undefined}
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
