import { useEffect, useMemo, useState } from "react"
import {
  formatChord,
  keysFor,
  useCommands,
  type DeskCommand,
} from "@/extend/commands"
import { Keys } from "@/components/ui/kit"
import { usePrefs } from "@/state/prefs"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { XIcon } from "lucide-react"

/**
 * What is where, and what the keys do.
 *
 * The alternative — a scripted tour with coach marks — was rejected on
 * purpose. A tour arrives before you have a reason to care, blocks the thing
 * it is describing, and is dismissed once and never seen again, which means
 * the one moment it could help (three weeks in, wondering what a panel is) is
 * the moment it is gone.
 *
 * This is the opposite: available whenever, on one key, showing everything at
 * once. The shortcut list is **generated from the command registry**, so it
 * cannot drift from what the app actually does — including anything a plugin
 * has registered. A hand-maintained list of keys is wrong within a month.
 */

interface Region {
  name: string
  commandId: string
  what: string
}

const REGIONS: Region[] = [
  {
    name: "Sidebar",
    commandId: "view.toggle-rail",
    what: "Your conversations from every agent, or the project's files. An attached session wears its working dot right on the row.",
  },
  {
    name: "Conversation",
    commandId: "session.focus-composer",
    what: "Ask here. While a turn runs, Enter steers it and ⌘↩ queues a follow-up.",
  },
  {
    name: "Surfaces",
    commandId: "view.toggle-companion",
    what: "Changes, files, the control preview, and agents open beside the chat from the palette; this key hides the sidebar or brings back the last one. The terminal opens independently below with ⌘J.",
  },
  {
    name: "Sessions",
    commandId: "tab.new",
    what: "A second conversation kept running beside this one. Background work keeps going; ⌘⇧[ and ⌘⇧] cycle through them.",
  },
  {
    name: "Account",
    commandId: "view.settings",
    what: "Who GitHub and your providers think you are — top right, with usage and a one-click account switch.",
  },
]

export function Guide() {
  const [open, setOpen] = useState(false)
  const commands = useCommands()
  const keybindings = usePrefs((prefs) => prefs.keybindings)

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener("mako:guide", show)
    return () => window.removeEventListener("mako:guide", show)
  }, [])

  /** Only commands with a chord: this is a key map, not a command list. */
  const sections = useMemo(() => {
    const grouped = new Map<string, Array<{ title: string; keys: string[] }>>()
    for (const command of commands) {
      const keys = keysFor(command, keybindings)
      if (!keys) continue
      const list = grouped.get(command.section) ?? []
      list.push({ title: command.title, keys: formatChord(keys) })
      grouped.set(command.section, list)
    }
    return [...grouped.entries()]
  }, [commands, keybindings])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="md" aria-label="What is where" className="flex max-h-[80vh] flex-col overflow-hidden p-0">
        <DialogTitle className="sr-only">What is where</DialogTitle>
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-3.5">
          <span className="text-ui font-medium">What is where</span>
          <span className="text-ui text-faint">and every key that does something</span>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="pressable ml-auto rounded p-1 text-faint hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3.5">
          <div className="flex flex-col gap-1.5">
            {REGIONS.map((region) => (
              <div key={region.name} className="flex items-start gap-3 rounded-lg bg-surface px-3 py-2">
                <span className="w-24 shrink-0 text-ui font-medium">{region.name}</span>
                <span className="min-w-0 flex-1 text-ui leading-relaxed text-muted-foreground">
                  {region.what}
                </span>
                <Chord keys={regionKeys(region, commands, keybindings)} />
              </div>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3">
            {sections.map(([section, entries]) => (
              <div key={section}>
                <p className="pb-1 text-label text-faint">{section}</p>
                {entries.map((entry) => (
                  <div key={entry.title} className="flex items-baseline gap-2 py-[3px]">
                    <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">
                      {entry.title}
                    </span>
                    <Keys keys={entry.keys} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function regionKeys(
  region: Region,
  commands: DeskCommand[],
  keybindings: Readonly<Record<string, string>>
): string | undefined {
  const command = commands.find((entry) => entry.id === region.commandId)
  return command ? keysFor(command, keybindings) : undefined
}

function Chord({ keys }: { keys?: string }) {
  if (!keys) return null
  return <Keys keys={formatChord(keys)} />
}
