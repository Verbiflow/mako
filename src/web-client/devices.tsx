import { useEffect, useMemo, useState } from "react"
import { errorMessage } from "@mako/host/contracts/error-message"
import { Devices, type MachineSheetProps } from "@/components/settings/devices"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { deviceReadings } from "./device-readings"
import { useForm } from "./route"
import { Sheet, SheetScroll } from "./sheet"

/** How often the devices' records are read again while Settings › Devices shows. */
const DEVICES_EVERY_MS = 60_000

/**
 * Settings › Devices in a browser: the desktop's own component (`Devices`), fed from the account's list this browser
 * follows. The devices and what each runs are the list's; while the list is current, a quiet device is the account's
 * own word (`device-quiet`) and one that lists work and isn't quiet is there, whatever its record's last sign-in says
 * (`deviceReadings`). A list from this browser's cache, or one being followed again, leaves each record to speak;
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
  const [failure, setFailure] = useState<{ device: string; message: string }>()
  // The cloud's own address is the gateway's word, said with this browser's connection: the page's origin passes on
  // only the app's routes, so a machine can't join there. Until it's said, the lines leave the cloud to the machine.
  const [cloud, setCloud] = useState<string>()
  useEffect(() => {
    let shown = true
    void client.gateway.connection().then(
      (connection) => shown && setCloud(connection.cloud),
      () => undefined
    )
    return () => {
      shown = false
    }
  }, [client])
  const asOf = useAccountList((state) => state.asOf)
  // This window's clock for how current the list is: read again with each re-read of the devices.
  const [now, setNow] = useState(() => Date.now())
  const readings = useMemo(() => deviceReadings({ rows, quiet, phase, asOf }, now), [rows, quiet, phase, asOf, now])
  // The devices' own records (their Mako, when each last signed in) are read again while this shows: once a minute and
  // whenever the window comes back to the front, as a Mac's Settings does. A read that fails keeps the last one.
  useEffect(() => {
    const read = () => {
      setNow(Date.now())
      void client.list.refreshDevices().catch(() => undefined)
    }
    read()
    const timer = setInterval(read, DEVICES_EVERY_MS)
    window.addEventListener("focus", read)
    return () => {
      clearInterval(timer)
      window.removeEventListener("focus", read)
    }
  }, [client])
  const list = useMemo(() => [...devices.values()], [devices])
  const remove = async (id: string): Promise<boolean> => {
    setRemoving(id)
    setFailure(undefined)
    try {
      await client.list.removeDevice(id)
      return true
    } catch (error) {
      setFailure({ device: id, message: errorMessage({ error }) })
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
      quiet={readings.quiet}
      heard={readings.heard}
      runs={readings.runs}
      removing={removing}
      busy={removing !== undefined}
      failure={failure}
      unread={undefined}
      eyebrow
      onRemove={remove}
      cloud={cloud}
      joined={joined}
      openUrl={(url) => void window.open(url, "_blank", "noopener")}
      Sheet={MachineSheet}
    />
  )
}

/**
 * Add a machine in a browser: a sheet from the bottom on a phone, a dialog in the middle on a tablet and a laptop. Its
 * steps and what it's waiting for are read together, so it's let stand taller than a choice's sheet before it scrolls.
 */
function MachineSheet({ open, onDismiss, title, children }: MachineSheetProps) {
  return (
    <Sheet open={open} onDismiss={onDismiss} label={title} className="max-h-[min(780px,calc(100%-32px))]!">
      <h2 className="web-sheet-title">{title}</h2>
      <SheetScroll className="px-5 pb-[calc(env(safe-area-inset-bottom)+20px)]">{children}</SheetScroll>
    </Sheet>
  )
}
