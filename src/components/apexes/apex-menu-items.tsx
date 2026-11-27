import { CornerDownRightIcon, Undo2Icon } from "lucide-react"
import { APEX_WORD } from "@mako/host/contracts/agents"
import { ApexMark } from "@/components/ui/apex-mark"
import { MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger } from "@/components/ui/menu"
import { confirmAction } from "@/state/confirm"
import { confirmLowered, demoteApex, moveIntoApex, openPromoteApex, useApex, useApexList } from "@/state/apexes"
import { useRailAcp } from "@/state/acp-state"
import { threadRollup } from "@/state/fin-rollup"

/**
 * A top-level Thread's menu: Make this an Apex, or Back to a Thread for one that is; and Move into Apex, each
 * deliberate Apex with what it covers. A Thread that leads Fins of its own is an Apex already and moves nowhere.
 */
export function ApexMenuItems({ thread, title, conversation }: { thread: string; title: string; conversation?: string }) {
  const apex = useApex(thread)
  const apexes = useApexList()
  const leads = useRailAcp((state) => threadRollup(state, thread).total > 0)
  const others = apexes.filter((each) => each.thread !== thread)
  const back = async () => {
    if (!apex) return
    const ok = await confirmAction({
      title: `Make ${apex.name} a Thread again?`,
      body: "It keeps its history, branch, plan and the Fins it started. Threads you moved into it go back to your list.",
      confirm: "Back to a Thread",
    })
    if (ok) await demoteApex(apex.thread, apex.name)
  }
  return (
    <>
      <MenuSeparator />
      {apex ? (
        <MenuItem data-thread-action="demote-apex" onSelect={() => void back()}>
          <Undo2Icon className="size-3.5" />Back to a Thread
        </MenuItem>
      ) : conversation ? (
        <MenuItem data-thread-action="promote-apex" onSelect={() => openPromoteApex(conversation, title)}>
          <ApexMark />Make this an {APEX_WORD}…
        </MenuItem>
      ) : null}
      {!apex && !leads && conversation && others.length ? (
        <MenuSub>
          <MenuSubTrigger data-thread-action="move-into-apex">
            <CornerDownRightIcon className="size-3.5" />Move into {APEX_WORD}
          </MenuSubTrigger>
          <MenuSubContent className="max-w-80 min-w-56">
            <MenuLabel>Works for one {APEX_WORD}, keeps its history</MenuLabel>
            {others.map((each) => (
              <MenuItem key={each.thread} data-move-into={each.thread} onSelect={() => void moveIntoApex(each, [thread], confirmLowered)} className="items-start">
                <ApexMark className="mt-0.5" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{each.name}</span>
                  {each.purpose ? <span className="line-clamp-2 text-label text-faint">{each.purpose}</span> : null}
                </span>
              </MenuItem>
            ))}
          </MenuSubContent>
        </MenuSub>
      ) : null}
    </>
  )
}
