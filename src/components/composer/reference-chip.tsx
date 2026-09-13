import { capabilityToken, fileKind, threadToken } from "@/lib/mentions"
import { isMakoServerName } from "@/lib/composer-capabilities"
import { fileName } from "@/lib/format"
import { findThreadReference } from "@/lib/thread-references"
import { desktop } from "@/state/desktop"
import { useThreads } from "@/state/threads"
import { MakoMark } from "@/components/ui/mako-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { cn } from "@/lib/utils"
import {
  BookOpenIcon,
  BracesIcon,
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  PaletteIcon,
  PlugIcon,
} from "lucide-react"

const KIND_ICON = {
  code: FileCodeIcon,
  style: PaletteIcon,
  config: BracesIcon,
  doc: FileTextIcon,
  image: ImageIcon,
  file: FileIcon,
}

/**
 * The inline form of a reference. The same chip renders in the composer and in
 * the transcript, which is what makes `@` feel like it produced an object
 * rather than decorated some text.
 */
export function FileChip({
  path,
  name,
  interactive,
}: {
  path: string
  name?: string
  interactive?: boolean
}) {
  const Icon = KIND_ICON[fileKind(path)]
  const body = (
    <>
      <Icon className="size-3 shrink-0 text-faint" />
      <span className="truncate">{name ?? fileName(path)}</span>
    </>
  )
  const className = cn(
    "inline-flex max-w-[18rem] items-baseline gap-1 rounded bg-raised px-1 align-baseline",
    "font-mono text-[0.92em] leading-[1.35] text-foreground/85 ring-1 ring-hairline ring-inset",
    "[&_svg]:translate-y-[1.5px]"
  )

  if (!interactive) {
    return (
      <span className={className} title={path} data-copy-file={path} data-copy-reference={`@${path}`}>
        {body}
      </span>
    )
  }
  return (
    <button
      type="button"
      title={`Open ${path}`}
      data-copy-file={path}
      data-copy-reference={`@${path}`}
      onClick={() => void desktop.revealPath(path)}
      className={cn(
        className,
        "pressable hover:bg-accent hover:text-foreground"
      )}
    >
      {body}
    </button>
  )
}

export function ThreadChip({
  harness,
  id,
}: {
  harness: string
  /** The token's id: the provider's identity, or a native id from an older draft. */
  id: string
}) {
  // The send resolves the same way, so the chip never names a conversation
  // the prompt would then report as unavailable.
  const thread = useThreads((state) =>
    findThreadReference(state.threads, harness, id)
  )
  return (
    <span
      title={thread?.title ?? `${harness} conversation`}
      data-copy-reference={threadToken(harness, id)}
      className={cn(
        "inline-flex max-w-[18rem] items-baseline gap-1 rounded bg-raised px-1 align-baseline",
        "text-[0.92em] leading-[1.35] text-foreground ring-1 ring-hairline ring-inset",
        "[&_svg]:translate-y-[1.5px]"
      )}
    >
      <HarnessIcon harness={harness} className="size-3 shrink-0 text-faint" />
      <span className="truncate">
        {thread?.title ?? "Referenced conversation"}
      </span>
    </span>
  )
}

const capabilityChipClass = cn(
  "inline-flex items-baseline gap-1 rounded bg-fill-selected px-1 align-baseline",
  "font-mono text-[0.92em] leading-[1.35] text-foreground ring-1 ring-border ring-inset",
  "[&_svg]:translate-y-[1.5px]"
)

export function SkillChip({ name }: { name: string }) {
  return (
    <span
      title={`Skill: ${name}`}
      data-copy-reference={capabilityToken("$", "skill", name)}
      className={capabilityChipClass}
    >
      <BookOpenIcon className="size-3 shrink-0 text-muted-foreground" />
      {name}
    </span>
  )
}

/** An MCP server the prompt points the agent at; Mako's own wear the fin. */
export function McpChip({ name }: { name: string }) {
  const builtIn = isMakoServerName(name)
  return (
    <span
      title={builtIn ? `Built-in Mako MCP server: ${name}` : `MCP server: ${name}`}
      data-copy-reference={capabilityToken("$", "mcp", name)}
      className={capabilityChipClass}
    >
      {builtIn ? (
        <MakoMark className="size-3 shrink-0 text-foreground" />
      ) : (
        <PlugIcon className="size-3 shrink-0 text-muted-foreground" />
      )}
      {name}
    </span>
  )
}
