import { useDeferredValue, useMemo, useState } from "react"
import { XIcon } from "lucide-react"
import { ApexMark } from "@/components/ui/apex-mark"
import { addressApex, routeSuggestion, unaddressApex, useApexAddressee, useApexList } from "@/state/apexes"
import { useWorktrees } from "@/state/worktrees"

/** "To Mobile": the Apex a message from `@` goes to, above the draft, until it's sent or cleared. */
export function ApexAddresseeNote({ draft }: { draft: string }) {
  const apex = useApexAddressee((state) => state.to[draft])
  if (!apex) return null
  return (
    <div data-apex-addressee={apex.name} className="flex min-w-0 items-center gap-1.5 px-4 pt-2.5 text-label text-faint">
      <span className="flex h-6 min-w-0 shrink items-center gap-1.5 bg-fill-hover pr-0.5 pl-2 text-ui text-foreground">
        <ApexMark className="text-muted-foreground" />
        <span className="min-w-0 truncate">To {apex.name}</span>
        <button
          type="button"
          aria-label="Write here instead"
          title="Write here instead"
          onClick={() => unaddressApex(draft)}
          className="pressable flex size-5 shrink-0 items-center justify-center text-faint hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      </span>
    </div>
  )
}

/**
 * A new Thread's message that one of the person's Apexes covers: its folder and purpose match, so the composer offers
 * to send it there instead, one tap; two that fit as well are both offered, the person choosing. Nothing when none
 * fits or the message is still a few words.
 */
export function ApexRouteNote({ draft, draftKey, folder, active }: { draft: string; draftKey: string; folder?: string; active: boolean }) {
  const apexes = useApexList()
  const addressed = useApexAddressee((state) => state.to[draftKey] !== undefined)
  const words = useDeferredValue(draft)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const project = useWorktrees((state) => (folder ? state.folderMap(folder) ?? folder : undefined))
  const route = useMemo(() => (active && words.trim().split(/\s+/).length >= 4 ? routeSuggestion(words, project, apexes.filter((apex) => apex.conversation)) : undefined), [active, words, project, apexes])
  if (!route || addressed) return null
  const fits = route.kind === "one" ? [route.apex] : route.apexes
  const key = fits.map((apex) => apex.thread).join(",")
  if (dismissed === key) return null
  const send = (thread: string) => {
    const apex = apexes.find((each) => each.thread === thread)
    if (apex?.conversation) addressApex(draftKey, { thread: apex.thread, name: apex.name, conversation: apex.conversation })
  }
  return (
    <div data-apex-route={route.kind} className="flex min-w-0 flex-wrap items-center gap-1.5 px-4 pt-2.5 text-label text-faint">
      <ApexMark className="size-3" />
      <span>{route.kind === "one" ? `${fits[0]!.name} covers this` : "Two of your Apexes cover this"}</span>
      {fits.map((apex) => (
        <button key={apex.thread} type="button" data-apex-route-to={apex.name} title={apex.purpose} onClick={() => send(apex.thread)} className="pressable flex h-6 items-center bg-fill-hover px-2 text-ui text-foreground hover:bg-fill-selected">
          Send to {apex.name}
        </button>
      ))}
      <button type="button" aria-label="Keep it a new Thread" title="Keep it a new Thread" onClick={() => setDismissed(key)} className="pressable flex size-5 items-center justify-center text-faint hover:text-foreground">
        <XIcon className="size-3" />
      </button>
    </div>
  )
}
