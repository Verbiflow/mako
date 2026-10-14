import { useGitPush } from "@/state/git-push"
import { GIT_CONFLICT_CONTEXT } from "@/lib/git-conflict-context"
import { PULL_REQUEST_CONTEXT } from "@/lib/pull-request-context"
import { pullRequestDetail } from "@/lib/pull-request-mentions"
import type { ContextInput } from "@/lib/context-detail"
import { usePullRequestSearch } from "@/state/pull-request-search"
import { useBranchPull } from "@/state/github"
import { APP_SETUP_CONTEXT, appSetupRow } from "@/lib/app-setup-context"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ArrowDownIcon, FolderIcon, GitMergeIcon, GitPullRequestIcon, BookOpenIcon, FileIcon, MessageCircleDashedIcon, PlayIcon, PlugIcon, ScanSearchIcon, SlashIcon, TargetIcon, WrenchIcon } from "lucide-react"
import { useGitCommands } from "@/state/git-actions"
import { REVIEW_COMMAND } from "@/state/reviews"
import type { GitCommandName } from "@mako/host/contracts/git-actions"
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
import { activeAcp, activeLiveAcp, useAcp } from "@/state/acp"
import {
  capabilityToken,
  fileKind,
  threadReferenceId,
  threadToken,
} from "@/lib/mentions"
import { cn } from "@/lib/utils"
import { mcpTransportsFor } from "@mako/host/contracts/mcp-reach"
import { UNIVERSAL_SKILL_PROVIDER } from "@mako/host/contracts/skill-reach"
import { useWorkspaceFiles } from "@/state/files"
import { mcp, useMcp } from "@/state/mcp"
import { useComposerAppView } from "@/state/project-setup"
import { useProviders } from "@/state/providers"
import { useSession } from "@/state/session"
import { skills, useSkills } from "@/state/skills"
import { useThreads } from "@/state/threads"
import type { LiveSessionCommand } from "@/lib/types"

const REFERENCE_LIMIT = 9
const EMPTY_COMMANDS: LiveSessionCommand[] = []

export type MentionKind = "@" | "/" | "#"

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
  /** Can't be picked now; `blocked` says why. */
  inert?: boolean
  icon: React.ReactNode
  /** A record the pick adds as a chip, in place of inserting `value`. */
  context?: ContextInput
  /** The title is a name typed as code (a command, skill, server, file), set in the code face; a conversation's or pull request's title is prose. */
  code?: boolean
}

const COMMAND_WORDS = {
  pr: "pull request open push github",
  update: "update from main merge behind",
  "fix-checks": "fix failing checks ci tests",
} satisfies Record<GitCommandName, string>

const GOAL_WORDS = "goal objective loop until done keep going autonomous"
const SIDE_WORDS = "btw side question aside ask while running quick"
const REVIEW_WORDS = "review code-review diff changes branch commit findings bugs"
/** Harness commands Mako's own rows stand in for. */
const MAKO_STANDS_IN = new Set(["goal", "btw", "side", "review", "code-review"])

const COMMAND_ICONS = {
  pr: GitPullRequestIcon,
  update: ArrowDownIcon,
  "fix-checks": WrenchIcon,
} satisfies Record<GitCommandName, typeof GitPullRequestIcon>

interface Group {
  label: string
  rows: Row[]
  /** Set when browsing shows only the first few; typing reaches the rest. */
  total?: number
}

/**
 * One menu for the composer's sigils. `@` offers context: conversations,
 * files and Mako's snapshots. `/` offers what can be invoked: at the start of
 * the draft the commands too, and anywhere the skills and MCP servers the
 * selected provider will actually have when it answers, with Mako's own
 * wearing the fin. `#` offers numbered things, pull requests first. They
 * share ranking, keyboard handling and geometry because from the user's side
 * they are the same gesture.
 */
export function MentionMenu({
  kind,
  leading,
  query,
  onPick,
  onDismiss,
  onVisibility,
}: {
  kind: MentionKind
  /** The sigil starts the draft, where `/` offers commands as well. */
  leading: boolean
  query: string
  onPick: (value: string, context?: ContextInput) => void
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
  const pull = useBranchPull()?.pull ?? null
  const capabilities = kind === "/"
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
  const appView = useComposerAppView()
  const { files } = useWorkspaceFiles(kind === "@")
  // Folders are every directory a listed file sits in; `@src/lib/` reads
  // as the folder, the way agent CLIs take a directory mention.
  const folders = useMemo(() => {
    const seen = new Set<string>()
    for (const file of files) {
      let at = file.path.lastIndexOf("/")
      while (at > 0) {
        const folder = file.path.slice(0, at)
        if (seen.has(folder)) break
        seen.add(folder)
        at = folder.lastIndexOf("/")
      }
    }
    return [...seen].sort()
  }, [files])

  const referenceGroups = useMemo<Group[]>(() => {
    if (capabilities) return []
    const conflicts = git?.files.filter(file => file.status === "conflicted").length ?? 0
    const app = appSetupRow(appView)
    const candidates = [
      ...(app ? [{
        value: APP_SETUP_CONTEXT,
        title: app.title,
        hint: app.hint,
        icon: <PlayIcon className="size-3.5" />,
        key: `app setup run start recipe environment ports check ${app.title} ${app.hint}`,
      }] : []),
      ...(git?.root && (conflicts || blockedPull) ? [{
        value: GIT_CONFLICT_CONTEXT,
        title: "Git conflicts",
        hint: blockedPull ? `${workspaceName(git.root)} · incoming changes` : `${workspaceName(git.root)} · ${conflicts} ${conflicts === 1 ? "file" : "files"}`,
        icon: <GitMergeIcon className="size-3.5" />,
        key: `git conflicts merge pull blocked untracked ${git.root}`,
      }] : []),
      ...(pull ? [{
        value: PULL_REQUEST_CONTEXT,
        title: `Pull request #${pull.number}`,
        hint: `${pull.title} · ${pull.state === "open" && pull.draft ? "draft" : pull.state}`,
        icon: <GitPullRequestIcon className="size-3.5" />,
        key: `pull request pr #${pull.number} ${pull.number} ${pull.title} ${pull.head} github checks review`,
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
        code: true,
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
      ...folders.map((folder) => ({
        value: `@${folder}/`,
        title: `${fileName(folder)}/`,
        hint: fileDir(folder),
        icon: <FolderIcon className="size-3.5 text-muted-foreground" />,
        code: true,
        key: `${folder}/ folder directory`,
      })),
    ]
    if (kind === "#") return []
    const rows = rankReferences(candidates, query)
    return rows.length ? [{ label: "Context", rows }] : []
  }, [appView, blockedPull, capabilities, files, folders, git, kind, pull, query, threads])

  // `#` names a pull request, any of the repository's, open, closed or merged.
  const pullSearch = usePullRequestSearch(kind === "#" ? query : null)
  const pullGroups = useMemo<Group[]>(() => {
    if (kind !== "#" || pullSearch.pulls.length === 0) return []
    return [{
      label: pullSearch.repository ? `Pull requests in ${pullSearch.repository}` : "Pull requests",
      rows: pullSearch.pulls.map((found) => {
        const state = found.state === "open" && found.draft ? "draft" : found.state
        return {
          value: `#${found.number}`,
          key: `pull:${found.number}`,
          title: `#${found.number} ${found.title}`,
          indices: [],
          hint: [state, found.head, found.author].filter(Boolean).join(" · "),
          icon: <GitPullRequestIcon className={cn("size-3.5", found.state === "open" ? undefined : "text-muted-foreground")} />,
          context: { detail: pullRequestDetail(found, pullSearch.repository), label: `#${found.number} ${found.title}` },
        } satisfies Row
      }),
    }]
  }, [kind, pullSearch])

  const capabilityGroups = useMemo<Group[]>(() => {
    if (!capabilities) return []
    return capabilityCatalog(skillsSnapshot, mcpSnapshot, harness, transports, query).groups.map(
      (group) => ({
        label: group.label,
        total: group.total,
        rows: group.matches.map(({ item, indices }) => ({
          value: capabilityToken("/", item.kind, item.name),
          key: `${item.kind}:${item.name}`,
          title: item.name,
          indices,
          hint: item.description,
          badge: item.badge,
          from: item.from,
          blocked: item.blocked,
          icon: <CapabilityGlyph item={item} />,
          code: true,
        })),
      })
    )
  }, [capabilities, harness, mcpSnapshot, query, skillsSnapshot, transports])

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

  const gitCommands = useGitCommands()
  const goal = useAcp((state) => activeAcp(state)?.goal)
  // Mako's own commands: the goal, side questions and review, which every harness gets, and the git
  // commands, which stage a message for the agent to use its `mako` tools;
  // one that can't apply here says why instead of hiding.
  const makoGroup = useMemo<Group[]>(() => {
    if (kind !== "/" || !leading) return []
    const term = query.trim()
    const goalMatch = fuzzy(term, "goal") ?? (fuzzy(term, GOAL_WORDS) && { score: 0, indices: [] })
    const goalRows = goalMatch ? [{ score: goalMatch.score, row: {
      value: "/goal",
      key: "mako:goal",
      code: true,
      title: "goal",
      indices: goalMatch.indices,
      hint: goal && goal.status !== "complete" ? `Working toward: ${goal.objective}` : "Keep working until an objective is met; --budget caps its tokens",
      icon: <TargetIcon className="size-3.5" />,
    } satisfies Row }] : []
    const sideMatch = fuzzy(term, "btw") ?? (fuzzy(term, SIDE_WORDS) && { score: 0, indices: [] })
    const sideRows = sideMatch ? [{ score: sideMatch.score, row: {
      value: "/btw",
      key: "mako:btw",
      code: true,
      title: "btw",
      indices: sideMatch.indices,
      hint: "Ask a side question without interrupting the turn",
      icon: <MessageCircleDashedIcon className="size-3.5" />,
    } satisfies Row }] : []
    const reviewMatch = fuzzy(term, "review") ?? (fuzzy(term, REVIEW_WORDS) && { score: 0, indices: [] })
    const reviewRows = reviewMatch ? [{ score: reviewMatch.score, row: {
      value: REVIEW_COMMAND,
      key: "mako:review",
      code: true,
      title: "review",
      indices: reviewMatch.indices,
      hint: "Review changes, a branch or a commit, without editing anything",
      icon: <ScanSearchIcon className="size-3.5" />,
    } satisfies Row }] : []
    const matches = gitCommands
      .map((command) => ({ command, match: fuzzy(term, command.name) ?? (fuzzy(term, COMMAND_WORDS[command.name]) && { score: 0, indices: [] }) }))
      .filter((entry) => entry.match)
    const scored = [...goalRows, ...sideRows, ...reviewRows, ...matches.map(({ command, match }) => {
      const Icon = COMMAND_ICONS[command.name]
      return { score: match?.score ?? 0, row: {
        value: command.prompt ?? `/${command.name}`,
        key: `mako:${command.name}`,
        code: true,
        title: command.name,
        indices: match?.indices ?? [],
        hint: command.blocked ?? command.hint,
        blocked: command.blocked,
        inert: !command.prompt,
        icon: <Icon className="size-3.5" />,
      } satisfies Row }
    })]
    // Typed words rank the rows; with none they keep their order.
    const rows = (term ? scored.toSorted((a, b) => b.score - a.score) : scored).map(({ row }) => row)
    return rows.length ? [{ label: "Mako", rows }] : []
  }, [gitCommands, goal, kind, leading, query])

  // Commands the running provider advertised come next: they are the one
  // thing only this session can answer.
  const commandGroup = useMemo<Group[]>(() => {
    if (kind !== "/" || !leading || commands.length === 0) return []
    const matches = commands
      // Mako's `/goal`, `/btw` and `/review` drive the harness's own goal, side question and review where it has them.
      .filter((command) => !MAKO_STANDS_IN.has(command.name))
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
          code: true,
          title: command.name,
          indices: match.indices,
          hint: command.description ?? command.hint,
          icon: <SlashIcon className="size-3.5 text-muted-foreground" />,
        })),
      },
    ]
  }, [commands, commandsHarness, kind, leading, query])

  const groups = useMemo(
    () => (capabilities ? [...makoGroup, ...commandGroup, ...capabilityGroups] : kind === "#" ? pullGroups : referenceGroups),
    [capabilities, kind, makoGroup, commandGroup, capabilityGroups, pullGroups, referenceGroups]
  )
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
  // `#` says what it's doing or why it can't, rather than vanishing.
  const pullNote =
    kind !== "#" || rows.length > 0
      ? null
      : pullSearch.status === "unavailable"
        ? (pullSearch.reason ?? "Pull requests can't be listed here")
        : pullSearch.status === "ready"
          ? query.trim() ? `No pull request matches “${query.trim()}”` : "This repository has no pull requests yet"
          : "Finding pull requests…"
  const hidden =
    rows.length === 0 && !pullNote && (capabilities ? Boolean(query.trim()) && !loading : true)

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
        if (row && !row.inert) onPick(row.value, row.context)
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [active, hidden, onDismiss, onPick, rows])

  if (hidden) return null

  const title = capabilities
    ? leading
      ? `Commands, skills and MCP for ${harnessTitle(harness)}`
      : `Skills and MCP for ${harnessTitle(harness)}`
    : kind === "#"
      ? "Mention a pull request"
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
        {pullNote ? (
          <div className="px-3 py-4 text-ui text-muted-foreground" data-pull-note>
            {pullNote}
          </div>
        ) : rows.length === 0 && loading ? null : rows.length === 0 ? (
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
                    aria-disabled={row.inert || undefined}
                    onClick={() => row.inert || onPick(row.value, row.context)}
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
                        "min-w-0 shrink-0 truncate text-ui",
                        row.code ? "font-mono" : "font-sans",
                        capabilities ? "max-w-[45%]" : row.code ? "max-w-[55%]" : "max-w-[70%]",
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
