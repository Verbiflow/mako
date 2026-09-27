import { useState } from "react"
import { RadioGroup } from "radix-ui"
import { CheckIcon, FolderIcon, GitBranchIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { setPref, usePrefs } from "@/state/prefs"
import { useSession } from "@/state/session"
import { useOnScreen } from "@/state/thread-sessions"

const CHOICES = [
  { value: "local", label: "Local", detail: "Works in the project folder, beside anything else running there", Icon: FolderIcon },
  {
    value: "worktree",
    label: "Worktree",
    detail: "Its own checkout and branch, so Threads don't touch each other's files. Your .env files come along",
    Icon: GitBranchIcon,
  },
] as const

/**
 * Where a new Thread starts: the project folder, or a worktree of its own.
 * Shown only for a new Thread in a Git project; the choice is remembered,
 * and is the same setting as Settings > Conversation.
 */
export function WorktreeChoice() {
  const inRepository = useSession((state) => Boolean(state.git?.root))
  const here = useOnScreen()
  const worktree = usePrefs((prefs) => prefs.newThreadsInWorktree)
  const [open, setOpen] = useState(false)
  if (!inRepository || here.thread || here.draft) return null
  const chosen = worktree ? CHOICES[1] : CHOICES[0]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Starts in: ${chosen.label}`}
          title={chosen.detail}
          className="pressable flex h-7 max-w-40 min-w-0 items-center gap-1.5 rounded-md px-2 text-ui text-faint hover:bg-fill-hover hover:text-foreground"
        >
          <chosen.Icon className="size-3 shrink-0" />
          <span data-collapse="1" className="truncate">
            {chosen.label}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-80 p-1">
        <p className="px-2 py-1.5 text-label text-faint">Where new threads start</p>
        <RadioGroup.Root
          aria-label="Where new threads start"
          value={chosen.value}
          onValueChange={(value) => {
            setPref("newThreadsInWorktree", value === "worktree")
            setOpen(false)
          }}
        >
          {CHOICES.map(({ value, label, detail, Icon }) => (
            <RadioGroup.Item
              key={value}
              value={value}
              className="pressable flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-fill-hover data-[state=checked]:bg-fill-selected"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-ui">
                  <Icon className="size-3 shrink-0" />
                  <span className="truncate">{label}</span>
                </span>
                <span className="text-label text-faint">{detail}</span>
              </span>
              <RadioGroup.Indicator className="mt-0.5">
                <CheckIcon className="size-3.5" />
              </RadioGroup.Indicator>
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </PopoverContent>
    </Popover>
  )
}
