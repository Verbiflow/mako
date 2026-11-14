import { useEffect, useMemo } from "react"
import { XIcon } from "lucide-react"
import { Devices, type MachineSheetProps } from "@/components/settings/devices"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Action, IconAction } from "@/components/ui/kit"
import { useAcp } from "@/state/acp"
import { cloudAccount, useCloudAccount } from "@/state/cloud-account"
import { desktop } from "@/state/desktop"
import { deviceEvidence, placeCounts } from "@/lib/device-places"
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
 * What this window knows runs where, as a few numbers a place (`placeCounts`): compared by its numbers, so a token
 * streaming somewhere wakes nothing.
 */
function usePlaceCounts(): Readonly<Record<string, number>> {
  return useAcp((state) => placeCounts(Object.values(state.conversations)), shallowEqual)
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
  const counts = usePlaceCounts()
  const list = useMemo<CloudDevice[]>(() => devices?.list ?? [current], [devices, current])
  // The account's word on each device counts only while this Mac's link to the account is up (`deviceEvidence`).
  const { runs, quiet, heard } = useMemo(() => deviceEvidence(counts, list, current.id, connection === "connected"), [counts, list, current.id, connection])
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
