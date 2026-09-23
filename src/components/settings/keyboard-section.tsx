import { useState } from "react"
import { SearchIcon } from "lucide-react"
import { Action, Keys, ListCard, Segmented, SettingRow } from "@/components/ui/kit"
import {
  chordFromEvent,
  formatChord,
  keysFor,
  useCommands,
  type DeskCommand,
} from "@/extend/commands"
import { setPref, usePrefs } from "@/state/prefs"
import { cn } from "@/lib/utils"

export function KeyboardSection() {
  const commands = useCommands()
  const keybindings = usePrefs((prefs) => prefs.keybindings)
  const optionAsMeta = usePrefs((prefs) => prefs.terminalOptionAsMeta)
  const [query, setQuery] = useState("")
  const [capturing, setCapturing] = useState<string>()
  const [candidate, setCandidate] = useState("")
  const term = query.trim().toLowerCase()
  const shown = commands.filter((command) =>
    term
      ? `${command.title} ${command.section} ${command.hint ?? ""}`
          .toLowerCase()
          .includes(term)
      : true
  )

  const save = (command: DeskCommand) => {
    const next = { ...keybindings }
    if (candidate === (command.keys ?? "")) delete next[command.id]
    else next[command.id] = candidate
    setPref("keybindings", next)
    setCapturing(undefined)
  }

  const groups = Map.groupBy(shown, (command) => command.section)

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md bg-shell/55 px-2.5 [box-shadow:inset_0_0_0_0.5px_var(--hairline)] focus-within:[box-shadow:inset_0_0_0_1px_var(--border)]">
            <SearchIcon className="size-3.5 shrink-0 text-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search commands"
              className="min-w-0 flex-1 bg-transparent text-ui text-foreground placeholder:text-faint focus:outline-none"
            />
          </label>
          {Object.keys(keybindings).length > 0 ? (
            <Action tone="ghost" onClick={() => setPref("keybindings", {})}>
              Reset all
            </Action>
          ) : null}
        </div>
        <p className="text-label leading-relaxed text-muted-foreground">
          Click a shortcut, then press the new keys. Mako shortcuts take priority
          inside the terminal; unassigned terminal keys still go straight to the shell.
        </p>
      </div>
      <ListCard>
        <SettingRow
          title="Option key in terminal"
          description="Auto uses Meta on a US layout and preserves characters on international layouts."
        >
          <Segmented
            label="Option key in terminal"
            value={optionAsMeta}
            options={[
              { value: "auto", label: "Auto" },
              { value: "on", label: "Meta" },
              { value: "off", label: "Characters" },
            ]}
            onChange={(value) => setPref("terminalOptionAsMeta", value)}
          />
        </SettingRow>
      </ListCard>
      {[...groups].map(([section, entries]) => (
        <div key={section} className="flex flex-col gap-2">
          <h3 className="px-1 text-label font-medium text-muted-foreground">{section}</h3>
          <ListCard className="px-1.5">
            {entries.map((command) => (
              <ShortcutRow
                key={command.id}
                command={command}
                commands={commands}
                keybindings={keybindings}
                capturing={capturing === command.id}
                candidate={candidate}
                onCapture={() => {
                  setCandidate(keysFor(command, keybindings) ?? "")
                  setCapturing(command.id)
                }}
                onCandidate={setCandidate}
                onCancel={() => setCapturing(undefined)}
                onSave={() => save(command)}
              />
            ))}
          </ListCard>
        </div>
      ))}
      {shown.length === 0 ? (
        <p className="py-8 text-center text-ui text-faint">No commands match.</p>
      ) : null}
    </section>
  )
}

function ShortcutRow({
  command,
  commands,
  keybindings,
  capturing,
  candidate,
  onCapture,
  onCandidate,
  onCancel,
  onSave,
}: {
  command: DeskCommand
  commands: DeskCommand[]
  keybindings: Readonly<Record<string, string>>
  capturing: boolean
  candidate: string
  onCapture: () => void
  onCandidate: (value: string) => void
  onCancel: () => void
  onSave: () => void
}) {
  const current = keysFor(command, keybindings) ?? ""
  const chord = capturing ? candidate : current
  const conflicts = shortcutConflicts(command, chord, commands, keybindings)

  return (
    <div className="px-1 py-1.5">
      <div className="flex min-h-8 items-center gap-3">
        <span className="min-w-0 flex-1 pl-1">
          <span className="block truncate text-ui text-foreground/90">
            {command.title}
          </span>
          {keybindings[command.id] !== undefined && command.keys ? (
            <span className="block text-label text-faint">
              Default {formatChord(command.keys).join("")}
            </span>
          ) : null}
        </span>
        {capturing ? (
          <button
            type="button"
            autoFocus
            aria-label={`Recording shortcut for ${command.title}`}
            data-keybinding-capture
            onKeyDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (event.key === "Escape") {
                onCancel()
                return
              }
              if (event.key === "Backspace" || event.key === "Delete") {
                onCandidate("")
                return
              }
              const next = chordFromEvent(event.nativeEvent)
              if (next) onCandidate(next)
            }}
            className="pressable flex h-7 min-w-28 items-center justify-center rounded-md bg-raised px-2 ring-1 ring-border"
          >
            {candidate ? (
              <Keys keys={formatChord(candidate)} />
            ) : (
              <span className="text-label text-faint">Press keys</span>
            )}
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Change shortcut for ${command.title}`}
            onClick={onCapture}
            className="pressable flex h-7 min-w-20 items-center justify-center rounded-md px-2 hover:bg-fill-hover"
          >
            {current ? (
              <Keys keys={formatChord(current)} />
            ) : (
              <span className="text-label text-faint">None</span>
            )}
          </button>
        )}
      </div>
      {capturing ? (
        <div className="mt-1.5 flex items-center gap-2 pl-0.5">
          <span
            className={cn(
              "min-w-0 flex-1 text-label",
              conflicts.length > 0 ? "text-caution" : "text-faint"
            )}
          >
            {conflicts.length > 0
              ? `Already used by ${conflicts.map((entry) => entry.title).join(", ")}`
              : candidate
                ? "Press Save to use this shortcut"
                : "Backspace removes the shortcut"}
          </span>
          <Action tone="ghost" onClick={onCancel}>
            Cancel
          </Action>
          <Action disabled={conflicts.length > 0} onClick={onSave}>
            Save
          </Action>
        </div>
      ) : conflicts.length > 0 ? (
        <p className="pt-1 text-label text-caution">
          Conflicts with {conflicts.map((entry) => entry.title).join(", ")}
        </p>
      ) : null}
    </div>
  )
}

function shortcutConflicts(
  command: DeskCommand,
  chord: string,
  commands: DeskCommand[],
  keybindings: Readonly<Record<string, string>>
): DeskCommand[] {
  if (!chord) return []
  return commands.filter(
    (entry) =>
      entry.id !== command.id &&
      keysFor(entry, keybindings)?.toLowerCase() === chord.toLowerCase()
  )
}
