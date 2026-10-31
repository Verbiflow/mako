import { useEffect, useMemo } from "react"
import { CheckIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { answered, macPlace, useReach } from "./reach"
import { useForm } from "./route"
import { hereOf } from "./trouble-state"
import { connectStep, macConnection, type ConnectStep } from "./mac-connection"

/** A Mac that joined is asked this often whether it's there, while the checklist shows and until it answers. */
const ASK_EVERY_MS = 5_000
/** And for this long at most: a Mac that hasn't answered by then is asked again by Try again, or by its own rows. */
const ASK_FOR_MS = 120_000
/** Once it's there, the finished checklist stays this long before it gives way. */
const SHOWN_DONE_MS = 1_600

/**
 * The account has no Mac that's ever been heard from: a short checklist that follows along on its own. It ticks
 * "Sign in" the moment a Mac joins (the account says so), and "Connected" the moment that Mac lists what it runs or
 * answers. Then it says so for a beat and gives way.
 */
export function ConnectMac({ onDone }: { onDone?: () => void }) {
  const client = useWebClient()
  const here = hereOf(useForm())
  const list = useAccountList((state) => state)
  const places = useReach((state) => state.places)
  const answeredMacs = useMemo(() => new Set([...list.devices.keys()].filter((id) => places.get(macPlace(id))?.ok)), [list.devices, places])
  const connection = macConnection(list, answeredMacs)
  const step = connectStep(connection)
  const joined = connection.mac?.id
  // A Mac that joined is asked whether it's there, a few times, while this shows: a Mac with nothing to list yet says
  // nothing on its own. Read only once it's needed.
  useEffect(() => {
    if (!joined || step !== "connect") return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const until = Date.now() + ASK_FOR_MS
    const ask = async () => {
      const { macCall } = await import("./start")
      if (stopped) return
      const there = await macCall<unknown>(client.gateway, client.deviceId, joined, "mako:harness-order-saved", []).then(() => true, () => false)
      if (stopped) return
      if (there) answered(macPlace(joined))
      else if (Date.now() < until) timer = setTimeout(() => void ask(), ASK_EVERY_MS)
    }
    void ask()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [client, joined, step])
  // Said done for a beat, then it gives way.
  const finished = step === "done"
  useEffect(() => {
    if (!finished || !onDone) return
    const timer = setTimeout(onDone, SHOWN_DONE_MS)
    return () => clearTimeout(timer)
  }, [finished, onDone])
  const name = connection.mac?.name ?? "your Mac"
  const steps: Array<{ id: ConnectStep; title: string; detail: string }> = [
    { id: "install", title: "Open Mako on your Mac", detail: "Install it from Mako's site if it isn't there yet." },
    { id: "sign-in", title: `Sign in as ${client.account.email}`, detail: connection.mac ? `${name} signed in.` : "Mako asks the first time it opens." },
    { id: "connect", title: connection.connected ? `${name} is connected` : "Wait for it to connect", detail: connection.connected ? "Its Threads show up here as it runs them." : connection.mac ? `Mako on ${name} connects on its own.` : "It connects on its own once it's signed in." },
  ]
  // Install and sign in are done together: the account hears of a Mac once it's signed in.
  const done = { install: connection.mac !== undefined, "sign-in": connection.mac !== undefined, connect: connection.connected } satisfies Record<ConnectStep, boolean>
  const current = steps.find((each) => !done[each.id])?.id
  return (
    <section className="web-connect" data-connect-step={step} aria-label="Connect your Mac">
      <p className="text-title font-semibold">Connect your Mac</p>
      <p className="mt-1 text-ui text-muted-foreground">Threads run on your Mac, or in the cloud. {here} follows them all.</p>
      <ol className="mt-5 flex flex-col">
        {steps.map((each, index) => {
          const state = done[each.id] ? "done" : each.id === current ? "current" : "next"
          const waiting = each.id === "connect" && state === "current" && connection.mac !== undefined
          return (
            <li key={each.id} className="web-connect-step" data-step={each.id} data-state={state}>
              <span className={cn("web-connect-mark", state === "done" && "web-connect-mark-done")} aria-hidden>
                {state === "done" ? <CheckIcon className="size-3.5" strokeWidth={3} /> : waiting ? <Spinner className="size-3.5" /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-ui", state === "next" ? "text-muted-foreground" : "font-medium text-foreground")}>{each.title}</span>
                <span className="block text-label text-faint">{each.detail}</span>
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
