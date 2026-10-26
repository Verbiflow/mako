import { SquareDashedMousePointerIcon } from "lucide-react"
import type { ComposerNotice } from "@/extend/notices"
import { elementPicks, useElementPicks } from "@/state/element-picks"

/** One line above the composer while a pick runs in a browser tab, with the way to end it from here. */
export function useElementPickNotice(): ComposerNotice | null {
  const active = useElementPicks((state) => state.active)
  if (!active) return null
  return {
    id: "element-pick",
    tone: "progress",
    icon: <SquareDashedMousePointerIcon className="text-muted-foreground" />,
    title: active.starting ? `Opening the picker in ${active.place}…` : `Point at an element in ${active.place}`,
    description: active.starting ? undefined : "then add it there",
    actions: [{ label: "Cancel", onClick: () => elementPicks.cancel() }],
  }
}
