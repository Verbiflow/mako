import { DropdownMenu } from "radix-ui"
import { CheckIcon, MoreHorizontalIcon } from "lucide-react"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import { stage, useStage } from "@/state/stage"
import { useTabs } from "@/state/tabs"
import { terminalActions } from "@/state/terminal"
import { dockTool } from "./dock-tab-style"

const item =
  "flex cursor-default items-center rounded px-2 py-1.5 text-ui outline-none data-[highlighted]:bg-fill-hover data-[disabled]:text-faint"
const keys = "ml-auto pl-4 text-label text-faint"
export function TerminalOptions({ canSplit, canSearch }: { canSplit: boolean; canSearch: boolean }) {
  const fontSize = usePrefs((prefs) => prefs.terminalFontSize)
  const fontFamily = usePrefs((prefs) => prefs.terminalFontFamily)
  const optionAsMeta = usePrefs((prefs) => prefs.terminalOptionAsMeta)
  const tabId = useTabs((state) => state.activeId)
  const expanded = useStage((state) => state.byTab[tabId]?.dockExpanded ?? false)
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Terminal options"
          title="Terminal options"
          className={dockTool}
        >
          <MoreHorizontalIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="overlay-panel z-50 w-60 p-1"
        >
          <DropdownMenu.Item
            disabled={!canSearch}
            className={item}
            onSelect={() => window.dispatchEvent(new CustomEvent("mako:terminal-search"))}
          >
            Find
            <span className={keys}>⌘F</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={item} onSelect={() => stage.toggleDockExpanded()}>
            {expanded ? "Restore size" : "Maximize"}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
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
          <div className="flex items-center justify-between px-2 py-1.5 text-ui">
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
          <label className="block px-2 py-1.5 text-ui">
            Font family
            <input
              aria-label="Terminal font family"
              placeholder="System monospace"
              value={fontFamily}
              onChange={(event) =>
                setPref("terminalFontFamily", event.target.value.slice(0, 200))
              }
              onKeyDown={(event) => event.stopPropagation()}
              className="mt-1 h-7 w-full rounded border border-hairline bg-surface px-2 text-label outline-none focus:border-border"
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
            <span className="flex-1">Use Option as Meta</span>
            {optionAsMeta === "on" ? (
              <CheckIcon className="size-3.5 text-muted-foreground" />
            ) : null}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
