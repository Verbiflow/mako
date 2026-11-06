import { useMemo, useState } from "react"
import { errorMessage } from "@mako/host/contracts/error-message"
import type { DeviceRuns } from "@mako/host/contracts/account-devices"
import { Devices, type MachineSheetProps } from "@/components/settings/devices"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { useForm } from "./route"
import { Sheet, SheetScroll } from "./sheet"

/**
 * Settings › Devices in a browser: the desktop's own component (`Devices`), fed from the account's list this browser
 * follows. The devices and what each runs are the list's; a quiet device is the account's own word (`device-quiet`);
 * a machine that joins is heard on the account's stream, so Add a machine says so as it happens. Removing one asks
 * the gateway, as any device of the account may.
 */
export function WebDevices() {
  const client = useWebClient()
  const form = useForm()
  const devices = useAccountList((state) => state.devices)
  const rows = useAccountList((state) => state.rows)
  const quiet = useAccountList((state) => state.quiet)
  const phase = useAccountList((state) => state.phase)
  const joined = useAccountList((state) => state.joined)
  const [removing, setRemoving] = useState<string>()
  const [failure, setFailure] = useState<string>()
  // A Session is a row of the list; which of them are Fins the list doesn't say, so none are counted here.
  const runs = useMemo(() => {
    const counts = new Map<string, DeviceRuns>()
    for (const row of rows) {
      if (row.runsOn.kind !== "device") continue
      const there = counts.get(row.runsOn.deviceId) ?? { sessions: 0, fins: 0 }
      counts.set(row.runsOn.deviceId, { ...there, sessions: there.sessions + 1 })
    }
    return counts
  }, [rows])
  const list = useMemo(() => [...devices.values()], [devices])
  const remove = async (id: string): Promise<boolean> => {
    setRemoving(id)
    setFailure(undefined)
    try {
      await client.list.removeDevice(id)
      return true
    } catch (error) {
      setFailure(errorMessage({ error }))
      return false
    } finally {
      setRemoving(undefined)
    }
  }
  return (
    <Devices
      form={form === "desk" ? "desk" : "touch"}
      devices={list.length || phase === "live" || phase === "reconnecting" ? list : undefined}
      current={client.deviceId}
      currentLabel="This browser"
      quiet={quiet}
      runs={runs}
      removing={removing}
      busy={removing !== undefined}
      failure={failure}
      unread={undefined}
      onRemove={remove}
      cloud={client.options.cloud}
      joined={joined}
      openUrl={(url) => void window.open(url, "_blank", "noopener")}
      Sheet={MachineSheet}
    />
  )
}

/** Add a machine in a browser: a sheet from the bottom on a phone, a dialog in the middle on a laptop. */
function MachineSheet({ open, onDismiss, title, children }: MachineSheetProps) {
  return (
    <Sheet open={open} onDismiss={onDismiss} label={title}>
      <h2 className="web-sheet-title">{title}</h2>
      <SheetScroll className="px-5 pb-[calc(env(safe-area-inset-bottom)+20px)]">{children}</SheetScroll>
    </Sheet>
  )
}
