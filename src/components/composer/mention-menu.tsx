import { useGitPush } from "@/state/git-push"
import { GIT_CONFLICT_CONTEXT } from "@/lib/git-conflict-context"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { GitMergeIcon, BookOpenIcon, FileIcon, PlugIcon, SlashIcon } from "lucide-react"
import { harnessTitle } from "@/components/composer/harness-title"
import { SkillSourceMark } from "@/components/composer/reference-chip"
import { Chip, Eyebrow, Keys } from "@/components/ui/kit"
import { MakoMark } from "@/components/ui/mako-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Shimmer } from "@/components/ui/shimmer"
import { Skeleton } from "@/components/ui/skeleton"
import {
  capabilityCatalog,
  skillItems,
  type CapabilityItem,
} from "@/lib/composer-capabilities"
import { fileDir, fileName, workspaceName } from "@/lib/format"
import { fuzzy, type FuzzyMatch } from "@/lib/fuzzy"
import { activeLiveAcp, useAcp } from "@/state/acp"
import {
  capabilityToken,
  fileKind,
  threadReferenceId,
  threadToken,
  type CapabilitySigil,
} from "@/lib/mentions"
import { cn } from "@/lib/utils"
import { mcpTransportsFor } from "../../../electron/contracts/mcp-reach"
import { UNIVERSAL_SKILL_PROVIDER } from "../../../electron/contracts/skill-reach"
import { useWorkspaceFiles } from "@/state/files"
import { mcp, useMcp } from "@/state/mcp"
import { useProviders } from "@/state/providers"
import { useSession } from "@/state/session"
import { skills, useSkills } from "@/state/skills"
import { useThreads } from "@/state/threads"
import type { LiveSessionCommand } from "@/lib/types"

const REFERENCE_LIMIT = 9
const EMPTY_COMMANDS: LiveSessionCommand[] = []

export type MentionKind = "@" | "$" | "/"

interface Row {
  /** The text inserted into the draft. */
  value: string
  /** Unique within the menu. */
  key: string
  title: string
  /** Glyph positions in `title` the query matched. */
  indices: number[]
  hint?: string
  badge?: string
  /** The provider whose copy this one would be handed, named beside the badge. */
  from?: string
  blocked?: string
  icon: React.ReactNode
}

interface Group {
  label: string
  rows: Row[]
  /** Set when browsing shows only the first few; typing reaches the rest. */
  total?: number
}

/**
 * One menu for all three composer sigils. `@` offers context — conversations
 * and files. `$` and `/` offer the same vocabulary of capabilities: the skills
 * and MCP servers the selected provider will actually have when it answers,
 * with Mako's own wearing the fin. They share ranking, keyboard handling and
 * geometry because from the user's side they are the same gesture.
 */
export function MentionMenu({
  kind,
  query,
  onPick,
  onDismiss,
  onVisibility,
}: {
  kind: MentionKind
  query: string
  onPick: (value: string) => void
  onDismiss: () => void
  /** Reports whether rows are showing, so the textarea keeps Enter otherwise. */
  onVisibility?: (visible: boolean) => void
}) {
  const harness = useThreads((state) => state.composerHarness)
  const driver = useProviders((state) => state.profiles[harness]?.transport)
  const transports = mcpTransportsFor(driver)
  const workspaceCwd = useSession((state) => state.meta?.cwd ?? "")
  const git = useSession(state => state.git)
  const remote = useGitPush(git?.root ?? "", git?.branch ?? "")
  const blockedPull = remote.kind === "failed" && (remote.reason === "untracked" || remote.reason === "dirty")
  const capabilities = kind !== "@"
  const skillsSnapshot = useSkills((state) => state.snapshot)
  const skillsStatus = useSkills((state) => state.status)
  const mcpSnapshot = useMcp((state) => state.snapshot)
  const mcpStatus = useMcp((state) => state.status)
  const loading =
    capabilities &&
    ((skillsStatus === "loading" && !skillsSnapshot) ||
      (mcpStatus === "loading" && !mcpSnapshot))

  // Discovery is workspace-bound and cached in the stores, so only the first
  // open in a workspace waits; the menu shows its shape while it does.
  useEffect(() => {
    if (!capabilities) return
    skills.ensure(workspaceCwd)
    mcp.ensure(workspaceCwd)
  }, [capabilities, workspaceCwd])

  const threads = useThreads((state) => state.threads)
  const { files } = useWorkspaceFiles(kind === "@")

  const referenceGroups = useMemo<Group[]>(() => {
    if (capabilities) return []
    const conflicts = git?.files.filter(file => file.status === "conflicted").length ?? 0
    const candidates = [
      ...(git?.root && (conflicts || blockedPull) ? [{
        value: GIT_CONFLICT_CONTEXT,
        title: "Git conflicts",
        hint: blockedPull ? `${workspaceName(git.root)} · incoming changes` : `${workspaceName(git.root)} · ${conflicts} ${conflicts === 1 ? "file" : "files"}`,
        icon: <GitMergeIcon className="size-3.5" />,
        key: `git conflicts merge pull blocked untracked ${git.root}`,
      }] : []),
      ...threads.map((thread) => ({
        value: threadToken(thread.harness, threadReferenceId(thread)),
        title: thread.title ?? "Untitled conversation",
        hint: [harnessTitle(thread.harness), thread.cwd ? workspaceName(thread.cwd) : null]
          .filter(Boolean)
          .join(" · "),
        icon: <HarnessIcon harness={thread.harness} className="size-3.5" />,
        key: `${thread.title ?? ""} ${thread.cwd ?? ""} ${thread.harness} ${thread.model ?? ""}`,
      })),
      ...files.map((file) => ({
        value: `@${file.path}`,
        title: fileName(file.path),
        hint: fileDir(file.path),
        badge: file.changed ? "changed" : undefined,
        icon: (
          <FileIcon
            className={cn(
              "size-3.5",
              fileKind(file.path) === "code" && "text-muted-foreground"
            )}
          />
        ),
        key: file.path,
      })),
    ]
    const rows = rankReferences(candidates, query)
    return rows.length ? [{ label: "Context", rows }] : []
  }, [blockedPull, capabilities, files, git, query, threads])

  const capabilityGroups = useMemo<Group[]>(() => {
    if (!capabilities) return []
    const sigil: CapabilitySigil = kind === "/" ? "/" : "$"
    return capabilityCatalog(skillsSnapshot, mcpSnapshot, harness, transports, query).groups.map(
      (group) => ({
        label: group.label,
        total: group.total,
        rows: group.matches.map(({ item, indices }) => ({
          value: capabilityToken(sigil, item.kind, item.name),
          key: `${item.kind}:${item.name}`,
          title: item.name,
          indices,
          hint: item.description,
          badge: item.badge,
          from: item.from,
          blocked: item.blocked,
          icon: <CapabilityGlyph item={item} />,
        })),
      })
    )
  }, [capabilities, harness, kind, mcpSnapshot, query, skillsSnapshot, transports])

  const foreign = useMemo(
    () => (capabilities ? skillItems(skillsSnapshot, harness).foreign : 0),
    [capabilities, harness, skillsSnapshot]
  )

  const commands = useAcp(
    (state) => activeLiveAcp(state)?.session.commands ?? EMPTY_COMMANDS
  )
  const commandsHarness = useAcp(
    (state) => activeLiveAcp(state)?.session.harness ?? harness
  )

  // Commands the running provider advertised lead the slash menu: they are
  // the one thing only this session can answer.
  const commandGroup = useMemo<Group[]>(() => {
    if (kind !== "/" || commands.length === 0) return []
    const matches = commands
      .map((command) => ({
        command,
        match: fuzzy(query.trim(), command.name),
      }))
      .filter(
        (entry): entry is { command: LiveSessionCommand; match: FuzzyMatch } =>
          entry.match !== null
      )
      .sort((a, b) => b.match.score - a.match.score)
    if (!matches.length) return []
    return [
      {
        label: `${harnessTitle(commandsHarness)} commands`,
        rows: matches.map(({ command, match }) => ({
          value: `/${command.name}`,
          key: `command:${command.name}`,
          title: command.name,
          indices: match.indices,
          hint: command.description ?? command.hint,
          icon: <SlashIcon className="size-3.5 text-muted-foreground" />,
        })),
      },
    ]
  }, [commands, commandsHarness, kind, query])

  const groups = capabilities
    ? [...commandGroup, ...capabilityGroups]
    : referenceGroups
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups])

  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const [lastQuery, setLastQuery] = useState(query)
  if (lastQuery !== query) {
    setLastQuery(query)
    setCursor(0)
  }
  const active = Math.min(cursor, Math.max(rows.length - 1, 0))

  // A typed `$5` or `/usr` has nothing to offer; the menu steps aside rather
  // than covering the draft with an empty panel or swallowing Enter.
  const hidden =
    rows.length === 0 && (capabilities ? Boolean(query.trim()) && !loading : true)

  useEffect(() => {
    onVisibility?.(!hidden)
    return () => onVisibility?.(false)
  }, [hidden, onVisibility])

  // Capture-phase so the menu wins these keys before the textarea sees them.
  useEffect(() => {
    if (hidden) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onDismiss()
        return
      }
      if (rows.length === 0) return
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        event.stopPropagation()
        setCursor((value) => {
          const next =
            (Math.min(value, rows.length - 1) +
              (event.key === "ArrowDown" ? 1 : -1) +
              rows.length) %
            rows.length
          listRef.current
            ?.querySelector(`[data-index="${next}"]`)
            ?.scrollIntoView({ block: "nearest" })
          return next
        })
        return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        event.stopPropagation()
        const row = rows[active]
        if (row) onPick(row.value)
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [active, hidden, onDismiss, onPick, rows])

  if (hidden) return null

  const title = capabilities
    ? `Skills and MCP for ${harnessTitle(harness)}`
    : "Add context"

  let index = -1
  return (
    <div
      role="dialog"
      aria-label={title}
      data-mention-menu={kind}
      data-loading={loading ? "" : undefined}
      className="animate-enter absolute bottom-full left-0 z-20 mb-1.5 w-full overflow-hidden rounded-lg bg-popover ring-1 ring-border"
    >
      <div className="flex h-8 items-center gap-2 border-b border-hairline px-3">
        {capabilities ? (
          <HarnessIcon harness={harness} className="size-3.5" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-label font-medium text-muted-foreground">
          {title}
        </span>
        {capabilities && !loading ? (
          <span className="shrink-0 text-label text-faint">
            {countLabel(capabilityGroups)}
          </span>
        ) : null}
      </div>

      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={title}
        className="max-h-[28rem] overflow-y-auto overscroll-contain p-1"
      >
        {rows.length === 0 && loading ? null : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-3 py-6 text-center">
            <span className="text-ui text-muted-foreground">
              {query.trim()
                ? `Nothing matches “${query.trim()}”`
                : `No skills or MCP servers reach ${harnessTitle(harness)} yet`}
            </span>
            <SettingsLink section="skills">Manage skills and MCP in Settings</SettingsLink>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <Eyebrow className="flex items-baseline gap-1.5 px-2 pt-1.5 pb-1">
                {group.label}
                {group.total !== undefined && group.total > group.rows.length ? (
                  <span className="font-normal text-faint/80">
                    {query.trim()
                      ? `${group.rows.length} of ${group.total}`
                      : `${group.rows.length} of ${group.total} · type to filter`}
                  </span>
                ) : null}
              </Eyebrow>
              {group.rows.map((row) => {
                index += 1
                const at = index
                const selected = at === active
                return (
                  <button
                    key={row.value}
                    id={`${listId}-${at}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-index={at}
                    title={row.blocked ?? row.hint}
                    onMouseMove={() => setCursor(at)}
                    onClick={() => onPick(row.value)}
                    className={cn(
                      "flex min-h-7 w-full items-center gap-2.5 rounded-md px-2 py-1 text-left",
                      // Direct-child glyphs rest quiet; the fin sits one level
                      // down so it keeps the foreground, which is the point.
                      "[&>svg]:shrink-0 [&>svg]:text-faint",
                      selected && "bg-fill-selected [&>svg]:text-foreground",
                      row.blocked && "opacity-55"
                    )}
                  >
                    {row.icon}
                    <span
                      className={cn(
                        "min-w-0 shrink-0 truncate font-mono text-ui",
                        capabilities ? "max-w-[45%]" : "max-w-[55%]",
                        selected ? "text-foreground" : "text-foreground/85"
                      )}
                    >
                      <Highlighted text={row.title} indices={row.indices} />
                    </span>
                    {row.hint ? (
                      <span className="min-w-0 flex-1 truncate text-label text-faint">
                        {row.hint}
                      </span>
                    ) : (
                      <span className="flex-1" />
                    )}
                    {row.from ? (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 text-label text-faint"
                        data-skill-from={row.from}
                      >
                        <SkillSourceMark from={row.from} className="size-3" />
                        {row.from === UNIVERSAL_SKILL_PROVIDER
                          ? "universal"
                          : harnessTitle(row.from)}
                      </span>
                    ) : null}
                    {row.badge ? (
                      <Chip
                        tone={row.badge === "changed" ? "caution" : "neutral"}
                        className="shrink-0 font-normal"
                      >
                        {row.badge}
                      </Chip>
                    ) : null}
                  </button>
                )
              })}
            </div>
          ))
        )}
        {loading ? <LoadingRows /> : null}
      </div>

      <div className="flex h-8 items-center gap-1 border-t border-hairline px-3 text-label text-faint">
        <Keys keys={["↑", "↓"]} /> move
        <Keys keys={["↩"]} /> insert
        <Keys keys={["Esc"]} /> dismiss
        <span className="flex-1" />
        {capabilities && foreign > 0 ? (
          <SettingsLink section="skills">
            {foreign === 1
              ? `1 skill is handed over · install it for ${harnessTitle(harness)}`
              : `${foreign} skills are handed over · install them for ${harnessTitle(harness)}`}
          </SettingsLink>
        ) : null}
      </div>
    </div>
  )
}

function CapabilityGlyph({ item }: { item: CapabilityItem }) {
  if (item.builtIn)
    return (
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-foreground" aria-label="Built into Mako">
        <MakoMark className="size-3.5" />
      </span>
    )
  if (item.kind === "mcp") return <PlugIcon className="size-3.5" />
  return <BookOpenIcon className="size-3.5" />
}

/** Matched glyphs weigh more than the rest of the name so a fuzzy hit explains itself. */
function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return text
  const hits = new Set(indices)
  const pieces: Array<{ text: string; hit: boolean }> = []
  for (let at = 0; at < text.length; at += 1) {
    const hit = hits.has(at)
    const last = pieces[pieces.length - 1]
    if (last && last.hit === hit) last.text += text[at]
    else pieces.push({ text: text[at] ?? "", hit })
  }
  return pieces.map((piece, at) =>
    piece.hit ? (
      <span key={at} className="font-semibold text-foreground">
        {piece.text}
      </span>
    ) : (
      <span key={at}>{piece.text}</span>
    )
  )
}

/** Discovery in flight: the rows keep their shape so the menu does not jump when they land. */
function LoadingRows() {
  return (
    <div className="skeleton-rows flex flex-col gap-1 px-1 py-1" aria-busy>
      <Eyebrow className="px-1 pt-0.5 pb-1"><Shimmer text="Reading skills and MCP servers…" /></Eyebrow>
      {[["w-24", "w-2/5"], ["w-32", "w-1/4"], ["w-20", "w-1/3"]].map(([name, detail]) => (
        <div key={name} className="flex h-7 items-center gap-2.5 px-1">
          <Skeleton className="size-3.5 rounded-sm" />
          <Skeleton className={`h-2.5 ${name}`} />
          <Skeleton className={`h-2.5 opacity-60 ${detail}`} />
        </div>
      ))}
    </div>
  )
}

function SettingsLink({
  section,
  children,
}: {
  section: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      // The composer closes the menu on blur; the settings request must be
      // dispatched before that blur lands, so it rides mousedown.
      onMouseDown={(event) => {
        event.preventDefault()
        window.dispatchEvent(new CustomEvent("mako:settings", { detail: section }))
      }}
      className="pressable rounded px-1 text-label text-muted-foreground hover:text-foreground"
    >
      {children}
    </button>
  )
}

/** Totals in a fixed order, so the header holds still while groups reorder under a query. */
function countLabel(groups: Group[]): string {
  const ordered = [...groups].sort((left, right) => Number(left.label !== "Skills") - Number(right.label !== "Skills"))
  const parts = ordered.map((group) => {
    const count = group.total ?? group.rows.length
    if (group.label === "Skills") return count === 1 ? "1 skill" : `${count} skills`
    return count === 1 ? "1 server" : `${count} servers`
  })
  return parts.join(" · ")
}

function rankReferences<T extends Omit<Row, "indices"> & { key: string }>(
  items: T[],
  query: string
): Row[] {
  const term = query.trim()
  if (!term)
    return items.slice(0, REFERENCE_LIMIT).map((item) => ({ ...item, indices: [] }))
  const top: Array<{ item: T; score: number }> = []
  for (const item of items) {
    const match = fuzzy(term, item.key)
    if (!match) continue
    const at = top.findIndex((entry) => match.score > entry.score)
    if (at === -1) top.push({ item, score: match.score })
    else top.splice(at, 0, { item, score: match.score })
    if (top.length > REFERENCE_LIMIT) top.pop()
  }
  return top.map((entry) => ({ ...entry.item, indices: [] }))
}
