import { useEffect, useRef, useState } from "react"
import { ChevronDownIcon, FolderIcon, FolderOpenIcon, MessageCircleIcon, SearchIcon } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Keys } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { formatRelative, workspaceName } from "@/lib/format"
import { fuzzy } from "@/lib/fuzzy"
import { tildePath } from "@/lib/project-query"
import { cn } from "@/lib/utils"
import { checkoutLabel, followCheckouts, useCheckoutHead } from "@/state/checkout-heads"
import { moveDraft, openProjectPalette, useOpenProject, useRecentProjects } from "@/state/open-project"
import { actions, useCanChooseFolder } from "@/state/session"

/** Projects the menu lists before anything is typed. */
const LISTED = 8

/**
 * A new Thread's project, as a control: its folder's name opens a menu of recent projects (⌘⇧O), and picking one
 * moves the unsent draft, words and all, to a new Thread there. Its branch follows it.
 */
export function ProjectChip({ cwd, chat }: { cwd: string | undefined; chat: boolean }) {
  const canChoose = useCanChooseFolder()
  const head = useCheckoutHead(chat ? undefined : cwd)
  const home = useOpenProject((state) => state.home)
  const branch = checkoutLabel(head)
  useEffect(() => {
    if (cwd && !chat) followCheckouts([cwd])
  }, [cwd, chat])
  const label = chat ? "New chat" : workspaceName(cwd)
  const Icon = chat ? MessageCircleIcon : FolderIcon
  if (!canChoose)
    return (
      <>
        <Icon className="size-3 shrink-0" />
        <span className="truncate" title={cwd}>{chat ? "New chat, with its own folder in ~/Mako/Chats" : (cwd ?? "no workspace")}</span>
      </>
    )
  return (
    <>
      <ProjectMenu cwd={cwd}>
        <button
          type="button"
          data-project-chip
          {...(chat ? { "data-empty-chat": true } : {})}
          title={chat ? "The first message makes this chat a folder of its own in ~/Mako/Chats" : `${tildePath(cwd ?? "", home)} · Switch project ${formatChord("mod+shift+o").join("")}`}
          className="pressable -mx-1 flex min-w-0 shrink items-center gap-1.5 px-1 text-ui text-muted-foreground transition-colors duration-100 hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-selected data-[state=open]:text-foreground"
        >
          <Icon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-3 shrink-0 text-faint" aria-hidden />
        </button>
      </ProjectMenu>
      {branch ? (
        <>
          <span className="text-faint/50">·</span>
          <span className="min-w-0 shrink truncate" data-project-chip-branch>{branch}</span>
        </>
      ) : null}
    </>
  )
}

function ProjectMenu({ cwd, children }: { cwd: string | undefined; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)
  const home = useOpenProject((state) => state.home)
  const recent = useRecentProjects()
  const list = useRef<HTMLDivElement>(null)
  const term = query.trim()
  const projects = (term
    ? recent.map((each) => ({ each, score: fuzzy(term, `${each.name} ${each.path}`)?.score })).filter((item) => item.score !== undefined).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((item) => item.each)
    : recent
  ).slice(0, LISTED)
  const actionsList = [
    { id: "open", title: "Open project…", icon: FolderOpenIcon, keys: formatChord("mod+o"), run: () => openProjectPalette() },
    { id: "chat", title: "New chat (no project)", icon: MessageCircleIcon, keys: formatChord("mod+shift+n"), run: () => void moveDraft(() => actions.newChat()) },
  ]
  const count = projects.length + actionsList.length
  const choose = (at: number) => {
    setOpen(false)
    const project = projects[at]
    if (project) {
      if (project.path !== cwd) void moveDraft(() => actions.newConversationIn(project.path))
      return
    }
    actionsList[at - projects.length]?.run()
  }
  const row = (at: number) => cn("flex h-8 w-full items-center gap-2.5 px-2 text-left text-ui", at === cursor ? "bg-fill-selected text-foreground" : "text-muted-foreground")
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setQuery("")
        setCursor(0)
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} collisionPadding={8} className="w-80 gap-0 p-0" data-project-menu>
        <div className="flex h-9 items-center gap-2 border-b border-hairline px-3">
          <SearchIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setCursor(0)
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault()
                const next = (cursor + (event.key === "ArrowDown" ? 1 : -1) + count) % Math.max(count, 1)
                setCursor(next)
                list.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" })
              }
              if (event.key === "Enter") {
                event.preventDefault()
                choose(cursor)
              }
            }}
            placeholder="Search projects"
            aria-label="Search projects"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-ui placeholder:text-faint focus:outline-none"
          />
        </div>
        <div ref={list} className="max-h-80 overflow-y-auto overscroll-contain p-1">
          {projects.length === 0 ? <p className="px-2 py-2 text-label text-faint">{term ? "No project by that name" : "No recent projects"}</p> : null}
          {projects.map((project, at) => (
            <button key={project.path} type="button" data-index={at} data-project-menu-item={project.path} onMouseMove={() => setCursor(at)} onClick={() => choose(at)} className={row(at)}>
              <FolderIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
              <span className="shrink-0 truncate">{project.name}</span>
              <span className="min-w-0 flex-1 truncate text-label text-faint">{tildePath(project.path, home)}</span>
              {project.path === cwd ? <span className="shrink-0 text-label text-faint">Here</span> : <span className="shrink-0 text-label text-faint">{formatRelative(project.at)}</span>}
            </button>
          ))}
          <div className="mx-1 my-1 h-px bg-hairline" />
          {actionsList.map((action, offset) => {
            const at = projects.length + offset
            const Icon = action.icon
            return (
              <button key={action.id} type="button" data-index={at} onMouseMove={() => setCursor(at)} onClick={() => choose(at)} className={row(at)}>
                <Icon className="size-3.5 shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{action.title}</span>
                <Keys keys={action.keys} />
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
