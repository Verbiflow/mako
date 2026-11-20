import { useEffect, useMemo, useState } from "react"
import { CircleIcon, ListChecksIcon, XIcon } from "lucide-react"
import { z } from "zod"
import { WorkGlyph } from "@/components/rail/work-status"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { install, installed, useInstallWay } from "./install"
import { IosInstallSheet } from "./install-card"
import { macConnection } from "./mac-connection"
import { macPlace, useReach } from "./reach"
import type { PushStanding } from "./push"

/** What a step is: its words, whether it's done, and what a tap on it does while it isn't. */
interface SetupStep {
  id: "mac" | "thread" | "home" | "notify"
  title: string
  done: boolean
  act?: () => void
}

const SetupCardSchema = z.object({ dismissed: z.boolean() })
const keyOf = (account: string) => `mako:web:setup-card:${account}`

function readDismissed(account: string): boolean {
  try {
    return SetupCardSchema.safeParse(JSON.parse(localStorage.getItem(keyOf(account)) ?? "null")).data?.dismissed === true
  } catch {
    return false
  }
}

/** This browser's notifications, as Settings reads them: unknown until read, or when the client can't say. */
function usePushStanding(): [PushStanding | undefined, (standing: PushStanding) => void] {
  const client = useWebClient()
  const [standing, setStanding] = useState<PushStanding | undefined>(undefined)
  useEffect(() => {
    let current = true
    // A stand-in client (a fixture's) may hold no push at all: its standing stays unknown, and the step isn't offered.
    Promise.resolve()
      .then(() => client.push.standing())
      .then((read) => current && setStanding(read.standing))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [client])
  return [standing, setStanding]
}

/**
 * The steps that are real from a phone, each read from what this browser knows: a Mac heard from, a Thread to follow,
 * Mako on the Home Screen (where the browser can put it there), and notifications on (where the browser has them).
 */
function useSetupSteps(onNew: () => void, onSettings: () => void, offerInstall: () => void): SetupStep[] {
  const client = useWebClient()
  const list = useAccountList((state) => state)
  const places = useReach((state) => state.places)
  const way = useInstallWay()
  const [push, setPush] = usePushStanding()
  return useMemo(() => {
    const answered = new Set([...list.devices.keys()].filter((id) => places.get(macPlace(id))?.ok))
    const mac = macConnection(list, answered).heard || list.rows.some((row) => row.runsOn.kind === "device")
    const steps: SetupStep[] = [
      { id: "mac", title: "Connect your Mac", done: mac },
      { id: "thread", title: "Start a Thread", done: list.rows.length > 0, act: onNew },
    ]
    const home = installed()
    if (home || way !== "none") steps.push({ id: "home", title: "Add Mako to your Home Screen", done: home, act: way === "prompt" ? () => void install() : offerInstall })
    if (push !== undefined && push !== "unsupported")
      steps.push({
        id: "notify",
        title: "Turn on notifications",
        done: push === "on",
        act:
          push === "off"
            ? () =>
                void client.push
                  .enable(null)
                  .then(setPush)
                  .catch(() => onSettings())
            : push === "install"
              ? offerInstall
              : onSettings,
      })
    return steps
  }, [list, places, way, push, client, onNew, onSettings, offerInstall, setPush])
}

/**
 * Finish setting up, at the top of the phone's list, as the desk's rail has it at its foot: the steps a phone can know,
 * ticked as each is done, gone once all are or once put away (kept on this device).
 */
export function SetupCard({ onNew, onSettings }: { onNew: () => void; onSettings: () => void }) {
  const client = useWebClient()
  const [dismissed, setDismissed] = useState(() => readDismissed(client.account.id))
  const [iosSteps, setIosSteps] = useState(false)
  const steps = useSetupSteps(onNew, onSettings, () => setIosSteps(true))
  const done = steps.filter((step) => step.done).length
  const sheet = <IosInstallSheet open={iosSteps} onDismiss={() => setIosSteps(false)} />
  if (dismissed || done === steps.length) return sheet
  const putAway = () => {
    setDismissed(true)
    try {
      localStorage.setItem(keyOf(client.account.id), JSON.stringify({ dismissed: true } satisfies z.infer<typeof SetupCardSchema>))
    } catch {
      // Storage full: put away for this visit.
    }
  }
  return (
    <>
      <section aria-label="Finish setting up" data-setup-card={`${done}/${steps.length}`} className="web-setup-card">
        <header className="flex h-10 items-center gap-2.5 pl-3">
          <ListChecksIcon aria-hidden className="size-4 text-muted-foreground" />
          <h2 className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">Finish setting up</h2>
          <span className="tabular text-label text-faint">
            {done} of {steps.length}
          </span>
          <button type="button" aria-label="Put away" data-setup-dismiss onClick={putAway} className="web-icon-button size-10">
            <XIcon className="size-4" />
          </button>
        </header>
        <ul role="list" className="pb-1.5">
          {steps.map((step) => (
            <li key={step.id}>
              <button type="button" data-setup-step={step.id} data-done={step.done || undefined} disabled={step.done || !step.act} onClick={step.act} className="web-setup-step">
                {step.done ? <WorkGlyph status="done" className="size-[18px]" /> : <CircleIcon aria-hidden className="size-[18px] text-faint" strokeWidth={1.5} />}
                <span className={cn("min-w-0 flex-1 truncate", step.done ? "text-faint line-through" : "text-foreground")}>{step.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {sheet}
    </>
  )
}
