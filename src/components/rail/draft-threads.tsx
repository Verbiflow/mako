import { PencilLineIcon } from "lucide-react"
import { workspaceName } from "@/lib/format"
import { projectDraftKey, useDrafts, type SessionDraft } from "@/state/drafts"
import { activeAcp, useAcp } from "@/state/acp"
import { actions, useSession } from "@/state/session"
import { useTabs } from "@/state/tabs"
import { useThreads } from "@/state/threads"

function sameDrafts(left: SessionDraft[], right: SessionDraft[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (draft, index) =>
        draft.key === right[index]?.key &&
        draft.text === right[index]?.text &&
        draft.updatedAt === right[index]?.updatedAt
    )
  )
}

export function DraftThreads() {
  const tabs = useTabs((state) => state.tabs)
  const activeTabId = useTabs((state) => state.activeId)
  const viewingPath = useThreads((state) => state.opening?.ref.path ?? state.viewing?.ref.path)
  const liveKey = useAcp((state) => activeAcp(state)?.draftKey)
  const cwd = useSession((state) => state.meta?.cwd ?? "")
  const activeDraftKey = liveKey ?? viewingPath ?? projectDraftKey(cwd)
  const drafts = useDrafts(
    (state) =>
      state.drafts
        .filter(
          (draft) =>
            draft.key !== activeTabId && draft.key !== activeDraftKey
        )
        .sort((left, right) => right.updatedAt - left.updatedAt),
    sameDrafts
  )
  const rows = drafts.flatMap((draft) => {
    const tab = tabs.find((candidate) => candidate.id === draft.key)
    const project = draft.key.startsWith("project:") ? draft.key.slice(8) : tab?.cwd
    return project ? [{ draft, tab, project }] : []
  })
  if (!rows.length) return null
  return (
    <section className="pt-1 pb-2">
      <p className="flex h-7 items-center gap-1.5 px-1.5 text-label font-medium text-faint">
        <PencilLineIcon className="size-3 opacity-60" />
        Drafts
      </p>
      {rows.slice(0, 4).map(({ draft, tab, project }) => (
        <button
          key={draft.key}
          type="button"
          onClick={() => void (tab ? actions.switchTab(tab.id) : actions.newConversationIn(project))}
          data-tip={draft.text}
          className="group flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors duration-100 hover:bg-fill-hover"
        >
          <PencilLineIcon className="size-3 shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">
            {draft.text.split("\n", 1)[0]}
          </span>
          <span className="max-w-20 shrink-0 truncate text-label text-faint/70">
            {workspaceName(project)}
          </span>
        </button>
      ))}
    </section>
  )
}
