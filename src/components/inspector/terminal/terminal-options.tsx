import { DropdownMenu } from "radix-ui"
import { MoreHorizontalIcon } from "lucide-react"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import { terminalActions } from "@/state/terminal"

const item =
  "flex cursor-default items-center rounded px-2 py-1.5 text-label outline-none data-[highlighted]:bg-fill-hover data-[disabled]:text-faint"
export function TerminalOptions({ canSplit }: { canSplit: boolean }) {
  const fontSize = usePrefs((prefs) => prefs.terminalFontSize)
  const fontFamily = usePrefs((prefs) => prefs.terminalFontFamily)
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Terminal options"
          title="Terminal options"
          className="pressable flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground"
        >
          <MoreHorizontalIcon className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="overlay-panel z-50 w-56 rounded-lg p-1"
        >
          <DropdownMenu.Item
            disabled={!canSplit}
            className={item}
            onSelect={() => void terminalActions.split("horizontal")}
          >
            Split right
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={!canSplit}
            className={item}
            onSelect={() => void terminalActions.split("vertical")}
          >
            Split down
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={item}
            onSelect={() => terminalActions.requestClose()}
          >
            Close terminal
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
          <div className="flex items-center justify-between px-2 py-1.5 text-label">
            <span>Font size</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Decrease terminal font size"
                disabled={fontSize <= 10}
                onClick={() =>
                  setPref("terminalFontSize", Math.max(10, fontSize - 1))
                }
                className="pressable size-6 rounded hover:bg-fill-hover disabled:opacity-40"
              >
                −
              </button>
              <span className="w-10 text-center tabular-nums">
                {fontSize} px
              </span>
              <button
                type="button"
                aria-label="Increase terminal font size"
                disabled={fontSize >= 24}
                onClick={() =>
                  setPref("terminalFontSize", Math.min(24, fontSize + 1))
                }
                className="pressable size-6 rounded hover:bg-fill-hover disabled:opacity-40"
              >
                +
              </button>
            </div>
          </div>
          <label className="block px-2 py-1.5 text-label">
            Font family
            <input
              aria-label="Terminal font family"
              placeholder="System monospace"
              value={fontFamily}
              onChange={(event) =>
                setPref("terminalFontFamily", event.target.value.slice(0, 200))
              }
              onKeyDown={(event) => event.stopPropagation()}
              className="mt-1 h-7 w-full rounded border border-hairline bg-surface px-2 font-mono text-label outline-none focus:border-border"
            />
          </label>
          <DropdownMenu.Item
            className={item}
            onSelect={() => {
              setPref("terminalFontSize", 12)
              setPref("terminalFontFamily", "")
            }}
          >
            Reset font
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
          <DropdownMenu.Item
            className={item}
            onSelect={() =>
              setPref(
                "terminalOptionAsMeta",
                prefsStore.get().terminalOptionAsMeta === "on" ? "off" : "on"
              )
            }
          >
            Option as Meta: {usePrefs((prefs) => prefs.terminalOptionAsMeta)}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
