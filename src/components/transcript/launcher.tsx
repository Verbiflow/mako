import { Keys } from "@/components/ui/kit"
import { formatChord, runCommand } from "@/extend/commands"
import {
  CircleCheckIcon,
  FileSearchIcon,
  FolderOpenIcon,
  GitCompareIcon,
  MapIcon,
  type LucideIcon,
} from "lucide-react"

/**
 * The empty transcript's launcher: one column of things worth doing next,
 * each an action with its chord — never an illustration of emptiness.
 *
 * The rows are useful actions on every empty thread. Prompt suggestions fill
 * the composer rather than sending, so the first message is still the user's.
 * A new chat has no project to explain, review or search, so it offers only
 * opening one.
 */
export function Launcher({ chat = false }: { chat?: boolean }) {
  if (chat)
    return (
      <div className="mt-6 flex flex-col gap-0.5">
        <LauncherRow index={0} icon={FolderOpenIcon} title="Open a project folder instead" keys={formatChord("mod+o")} onRun={() => runCommand("workspace.open")} />
      </div>
    )
  return (
    <div className="mt-6 flex flex-col gap-0.5">
      {SUGGESTIONS.map((suggestion, index) => (
        <LauncherRow
          key={suggestion.text}
          index={index}
          icon={suggestion.icon}
          title={suggestion.text}
          onRun={() =>
            window.dispatchEvent(
              new CustomEvent("mako:compose", {
                detail: { text: suggestion.text },
              })
            )
          }
        />
      ))}
      <LauncherRow
        index={SUGGESTIONS.length}
        icon={FolderOpenIcon}
        title="Open another folder"
        keys={formatChord("mod+o")}
        onRun={() => runCommand("workspace.open")}
      />
      <LauncherRow
        index={SUGGESTIONS.length + 1}
        icon={FileSearchIcon}
        title="Open a file by name"
        keys={formatChord("mod+p")}
        onRun={() => runCommand("view.quick-open")}
      />
    </div>
  )
}

const SUGGESTIONS: Array<{ text: string; icon: LucideIcon }> = [
  { text: "Explain how this project is structured", icon: MapIcon },
  { text: "Review my uncommitted changes", icon: GitCompareIcon },
  { text: "Find and fix the failing test", icon: CircleCheckIcon },
]

function LauncherRow({
  index,
  icon: Icon,
  title,
  keys,
  onRun,
}: {
  index: number
  icon?: LucideIcon
  title: string
  keys?: string[]
  onRun: () => void
}) {
  return (
    <button
      type="button"
      // A short stagger on first paint; the list reads as arriving rather
      // than as having always been there. 45ms stays under the threshold
      // where waiting becomes perceptible.
      style={{ animationDelay: `${60 + index * 45}ms` }}
      onClick={onRun}
      className="pressable group animate-enter flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-ui text-muted-foreground [transition:transform_var(--duration-press)_var(--ease-out),color_120ms_ease,background-color_120ms_ease] hover:bg-fill-hover hover:text-foreground"
    >
      {Icon ? (
        <Icon className="size-3.5 shrink-0 text-faint transition-colors duration-100 group-hover:text-foreground/80" />
      ) : null}
      <span className="min-w-0 flex-1 truncate">
        {title}
      </span>
      {keys ? <Keys keys={keys} /> : null}
    </button>
  )
}
