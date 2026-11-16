import { useRef, useState } from "react"
import { AtSignIcon, BookOpenIcon, PaperclipIcon, PlugIcon, PlusIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slot } from "@/extend/slot"
import type { ComposerControlSlotProps } from "@/extend/slots"

const itemClass = "pressable flex min-h-9 w-full items-center gap-3 px-3 py-2 text-left text-ui text-foreground hover:bg-fill-hover focus-visible:bg-fill-hover disabled:opacity-40"

export function ComposerAdditions({ onAttach, onReference, ...controls }: ComposerControlSlotProps & { onAttach(): void; onReference(sigil: "@" | "/"): void }) {
  const [open, setOpen] = useState(false)
  // The sigil goes into the composer, and focus with it, once the popover has closed: Radix returns focus to the trigger
  // after the exit animation, which a frame's wait didn't outlast, and the composer was left with "@" and no focus.
  const pending = useRef<"@" | "/" | undefined>(undefined)
  const reference = (sigil: "@" | "/") => {
    pending.current = sigil
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Add to message" disabled={controls.disabled} className="pressable flex size-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-fill-hover hover:text-foreground disabled:opacity-40">
          <PlusIcon className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} aria-label="Add to message" className="w-64 gap-0 p-1.5"
        onCloseAutoFocus={(event) => {
          const sigil = pending.current
          if (!sigil) return
          pending.current = undefined
          event.preventDefault()
          onReference(sigil)
        }}>
        <button type="button" className={itemClass} onClick={() => { onAttach(); setOpen(false) }}>
          <PaperclipIcon className="size-4 text-muted-foreground" />Attach a file
        </button>
        <Slot name="composer.controls" {...controls} dismiss={() => setOpen(false)} />
        <div className="my-1 border-t border-hairline" />
        <button type="button" data-add="reference" className={itemClass} onClick={() => reference("@")}>
          <AtSignIcon className="size-4 text-muted-foreground" />Add context<span className="ml-auto text-label text-faint">@</span>
        </button>
        <button type="button" data-add="skill" className={itemClass} onClick={() => reference("/")}>
          <BookOpenIcon className="size-4 text-muted-foreground" />Use a skill or command<span className="ml-auto text-label text-faint">/</span>
        </button>
        <div className="my-1 border-t border-hairline" />
        <button type="button" data-add="mcp" className={itemClass} onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent("mako:settings", { detail: "mcp" })) }}>
          <PlugIcon className="size-4 text-muted-foreground" />Manage MCP tools
        </button>
      </PopoverContent>
    </Popover>
  )
}
