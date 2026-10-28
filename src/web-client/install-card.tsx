import { useEffect, useState } from "react"
import { PlusSquareIcon, ShareIcon, XIcon } from "lucide-react"
import { MakoMark } from "@/components/ui/mako-mark"
import { install, noteVisit, readOffer, shouldOffer, SNOOZE_MS, useInstallWay, writeOffer } from "./install"
import { Sheet } from "./sheet"

/**
 * The offer to add Mako to the Home Screen, at the foot of the list, once it has earned it: Chrome's own prompt where
 * the browser has one, the two steps of the Share menu on an iPhone. Never inside the installed app.
 */
export function InstallCard() {
  const way = useInstallWay()
  const [offered, setOffered] = useState(() => shouldOffer())
  const [steps, setSteps] = useState(false)
  useEffect(() => noteVisit(), [])
  if (way === "none" || !offered) return null
  const notNow = () => {
    writeOffer({ ...readOffer(), snoozedUntil: Date.now() + SNOOZE_MS })
    setOffered(false)
  }
  return (
    <>
      <aside aria-label="Add to Home Screen" className="web-install mx-3 mt-6 flex items-start gap-3 rounded-2xl p-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-shell ring-1 ring-hairline">
          <MakoMark className="size-5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-ui font-medium text-foreground">Add Mako to your Home Screen</span>
          <span className="text-label text-muted-foreground">Get a notification when a Thread needs you.</span>
          <span className="mt-2.5 flex gap-2">
            <button type="button" className="web-button h-9 px-4" onClick={() => (way === "prompt" ? void install() : setSteps(true))}>
              Add
            </button>
            <button type="button" className="web-quiet-button h-9 px-3" onClick={notNow}>
              Not now
            </button>
          </span>
        </span>
        <button type="button" aria-label="Not now" onClick={notNow} className="web-icon-button -mt-2 -mr-2 size-9">
          <XIcon className="size-4" />
        </button>
      </aside>
      <IosInstallSheet open={steps} onDismiss={() => setSteps(false)} />
    </>
  )
}

/** An iPhone's two steps, with Safari's own glyphs, and the one thing that surprises people after: signing in there. */
export function IosInstallSheet({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  return (
    <Sheet open={open} onDismiss={onDismiss} label="Add Mako to your Home Screen">
      <div className="flex flex-col gap-5 px-5 pt-1 pb-[calc(env(safe-area-inset-bottom)+20px)]">
        <h2 className="text-title font-semibold">Add to Home Screen</h2>
        <ol className="flex flex-col gap-4 text-ui">
          <li className="flex items-center gap-3">
            <span className="web-step">1</span>
            <span className="flex flex-wrap items-center gap-1.5">
              Tap <ShareIcon aria-label="Share" className="size-[18px] text-foreground" /> in Safari's toolbar
            </span>
          </li>
          <li className="flex items-center gap-3">
            <span className="web-step">2</span>
            <span className="flex flex-wrap items-center gap-1.5">
              Choose <PlusSquareIcon aria-hidden className="size-[18px]" /> Add to Home Screen
            </span>
          </li>
          <li className="flex items-center gap-3">
            <span className="web-step">3</span>
            <span>Open Mako from your Home Screen and sign in there once</span>
          </li>
        </ol>
        <button type="button" className="web-button h-12 justify-center" onClick={onDismiss}>
          Done
        </button>
      </div>
    </Sheet>
  )
}
