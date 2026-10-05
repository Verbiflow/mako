import { GitActionControl } from "@/components/inspector/git-action-control"
import { CopyGitContextButton, GitConflictFooter, GitDetailsButton } from "@/components/inspector/git-conflict-footer"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Action, Keys } from "@/components/ui/kit"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { ReasonedItem } from "@/components/inspector/git-action-control"
import { cn } from "@/lib/utils"
import { Notice as SharedNotice } from "@/components/ui/notice"
import { formatChord } from "@/extend/commands"
import { git } from "@/state/git"
import { actions, useSession } from "@/state/session"
import { usePrefs } from "@/state/prefs"
import { commitDrafts, draftRepository, useCommitDraft } from "@/state/commit-drafts"
import { refreshCommitModel, useResolvedCommitModel } from "@/state/commit-model"
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, GitBranchIcon, GitPullRequestIcon } from "lucide-react"
import { Orb } from "@/components/ui/orb/orb"
import { useOrbTheme } from "@/components/ui/use-orb-theme"
import { BorderBeam } from "border-beam"
import { useGitPush } from "@/state/git-push"
import { pullComposer, useBranchPull } from "@/state/github"
import { pullSetupReason } from "@/lib/pull-requests"
import { useWorktrees, worktreeAt } from "@/state/worktrees"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"

/**
 * The commit box.
 *
 * Modelled on Zed's: a message field with a draft button beside it and commit
 * on ⌘↩. The draft goes through the session's own model against the staged
 * patch (or the working tree when nothing is staged), which is the same rule
 * Zed follows and the one that matches what the commit will actually contain.
 *
 * The box mirrors the composer: the field, then one toolbar row that never
 * wraps — generation controls on the left, the primary action on the right.
 * The button is Commit, or Commit all when nothing is staged; the count is
 * the Changes header's and the empty field's placeholder's to say. Nothing
 * here disables while a stage write is in flight: the engine
 * queues every index write and the commit itself per repository, so a commit
 * clicked mid-staging runs after the write and includes it.
 */
export function CommitBox({ staged, total }: { staged: number; total: number }) {
  const status = useSession(state => state.git)
  const root = status?.root
  const resolving = Boolean(status?.operation || status?.files.some(file => file.status === "conflicted"))
  // Several repositories share one footer, so it names the one it commits to.
  const named = Boolean(status?.repositories?.length)
  return <div data-git-footer className="shrink-0 border-t border-hairline">
    <CommitEditor staged={staged} total={total} />
    {root && status.branch ? <>
      {!resolving ? <GitRemoteNotice cwd={root} branch={status.branch} /> : null}
      {/* As Zed's panel ends: the branch the commit lands on, and what to do with it next. */}
      <div data-git-actions data-repository={root} className="flex h-9 items-center gap-2 pr-2 pl-3">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-label" title={`${root} · ${status.branch}`}>
          {named ? <span className="shrink-0 text-faint">{root.split("/").filter(Boolean).at(-1)}</span> : null}
          <GitBranchIcon className="size-3 shrink-0 text-faint" />
          <span className="min-w-0 truncate text-muted-foreground">{status.branch}</span>
          {status.ahead > 0 ? <span className="tabular flex shrink-0 items-center text-faint" title={`${status.ahead} ${status.ahead === 1 ? "commit" : "commits"} to push`}><ArrowUpIcon className="size-3" />{status.ahead}</span> : null}
          {status.behind > 0 ? <span className="tabular flex shrink-0 items-center text-faint" title={`${status.behind} incoming ${status.behind === 1 ? "commit" : "commits"}`}><ArrowDownIcon className="size-3" />{status.behind}</span> : null}
        </span>
        {status.head ? <GitActionControl cwd={root} branch={status.branch} /> : null}
      </div>
    </> : null}
  </div>
}

function CommitEditor({
  staged,
  total,
}: {
  staged: number
  total: number
}) {
  const cwd = useSession(draftRepository)
  const draftState = useCommitDraft(cwd)
  const message = draftState.text
  const drafting = draftState.requestId !== null
  const theme = useOrbTheme()
  const { model, label: modelLabel, status: connection } = useResolvedCommitModel()
  const hasModel = Boolean(model)
  const disconnected = connection.kind === "disconnected"
  const [busy, setBusy] = useState(false)
  const committing = useRef(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const draftKeys = usePrefs(
    (prefs) => prefs.keybindings["workspace.generate-commit"] ?? "mod+shift+g"
  )

  const branch = useSession((state) => state.git?.branch)
  const pushState = useGitPush(cwd, branch ?? "")
  const operation = useSession((state) => state.git?.operation)
  const files = useSession((state) => state.git?.files)
  const conflicts = useMemo(() => files?.filter((file) => file.status === "conflicted") ?? [], [files])
  const root = useSession((state) => state.git?.root)
  const inWorktree = useWorktrees((state) => Boolean(worktreeAt(state.worktrees, cwd)))
  const branchPull = useBranchPull()
  // Why "Commit and open pull request" can't, or null when it can.
  const pullBlocked = !branchPull ? "Checking GitHub…"
    : pullSetupReason(branchPull.status)
      ?? (branchPull.pull?.state === "open" ? `#${branchPull.pull.number} is already open; Commit and push updates it.` : null)
      ?? (!inWorktree && branchPull.status.defaultBranch === branch ? `Pull requests come from a branch other than ${branch}.` : null)

  useLayoutEffect(() => {
    const node = field.current
    if (!node) return
    node.style.height = "0px"
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`
  }, [message])

  // The host's choice is read when the box appears and when the window comes
  // back, since Settings or a sign-in elsewhere may have changed it.
  useEffect(() => {
    void refreshCommitModel()
    const focus = () => void refreshCommitModel()
    window.addEventListener("focus", focus)
    return () => window.removeEventListener("focus", focus)
  }, [])

  const draft = useCallback(
    async function draftCommitMessage() {
      if (drafting || busy || !cwd || !total) return
      if (!hasModel || disconnected) {
        openModelSettings()
        return
      }
      await commitDrafts.generate(cwd)
    },
    [drafting, busy, cwd, total, hasModel, disconnected]
  )

  const commit = useCallback(
    async function commitChanges(then?: "push" | "pull") {
      if (operation || conflicts.length || pushState.kind === "syncing" || !message.trim() || committing.current || busy || drafting) return
      committing.current = true
      setBusy(true)
      try {
        await git.commit(message.trim())
        commitDrafts.committed(cwd, draftState.revision)
        await actions.refreshGit()
        if (then === "push") void git.push()
        else if (then === "pull" && root) pullComposer.open(root)
      } catch (error) {
        toast.error("Check commit status before trying again", {
          duration: ACTION_TOAST_MS,
          description: error instanceof Error ? error.message : String(error),
          action: { label: "Refresh Changes", onClick: () => void actions.refreshGit() },
        })
      } finally {
        committing.current = false
        setBusy(false)
      }
    },
    [busy, message, drafting, cwd, draftState.revision, operation, conflicts.length, pushState.kind, root]
  )

  // The button says only what changes the commit's meaning. With something
  // staged it is Git's ordinary Commit: the staged list above is the scope.
  // With nothing staged Mako commits the whole working tree, as Zed does, and
  // that one case gets the word for it. The count itself lives in the
  // Changes header and, while the field is empty, in the placeholder; the
  // button once repeated it a third time ("Commit 2 files") and was the
  // longest thing in a 300px row.
  const count = staged > 0 ? staged : total
  const noun = count === 1 ? "file" : "files"
  const placeholder =
    total === 0
      ? "Nothing to commit"
      : staged > 0
        ? `Message for ${count} staged ${noun}`
        : `Message for all ${count} ${noun}`
  const commitLabel = busy
    ? "Committing..."
    : total > 0 && staged === 0
      ? "Commit all"
      : "Commit"
  // A message makes the button the row's one lit control, as typing lights
  // the composer's send; empty, it is a quiet ghost with nothing to press.
  const armed = message.trim().length > 0

  // ⌘↩ commits while the message field has focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod) return
      if (event.key === "Enter" && field.current === document.activeElement) {
        event.preventDefault()
        void commit()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [commit])

  if (operation || conflicts.length) return <GitConflictFooter count={conflicts.length} operation={operation} busy={pushState.kind === "syncing"} detail={pushState.kind === "failed" ? pushState.detail : undefined} />

  return (
    <div data-commit-box data-busy={drafting || busy || pushState.kind === "pushing" || undefined} data-drafting={drafting || undefined} className="shrink-0 px-2.5 pt-2.5 pb-0.5">
      <BorderBeam size="md" colorVariant="mono" theme={theme} active={drafting} brightness={1.8} borderRadius={0}>
      <div className="commit-editor relative overflow-hidden rounded-lg bg-raised ring-1 ring-hairline focus-within:ring-border">
        <textarea
          aria-label="Commit message"
          ref={field}
          rows={2}
          value={message}
          onChange={(event) => commitDrafts.edit(cwd, event.target.value)}
          placeholder={placeholder}
          disabled={total === 0}
          spellCheck={false}
          className="block max-h-40 min-h-16 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-ui leading-5 placeholder:text-faint focus:outline-none disabled:opacity-50"
        />

        {/* What the last draft left behind lives inside the card, between the
            field and its toolbar, as one notice at a time: the draft it wrote
            beside text you had typed, the files it left out, or why it
            failed. These used to stack above the card as three unrelated
            blocks — a red exception, a bordered box, a details element —
            and read as debris. */}
        {draftState.suggestion ? (
          <Notice label="Draft ready, your text was kept">
            <pre className="max-h-24 overflow-auto font-sans text-ui leading-5 whitespace-pre-wrap text-foreground">
              {draftState.suggestion.message}
            </pre>
            <div className="mt-2 flex gap-1">
              <Action size="xs" tone="outline" onClick={() => commitDrafts.accept(cwd)}>
                Use draft
              </Action>
              <Action size="xs" onClick={() => commitDrafts.dismiss(cwd)}>
                Keep mine
              </Action>
            </div>
          </Notice>
        ) : draftState.error && !disconnected ? (
          // A failure whose cause is a lost connection is not a notice: the
          // toolbar has already turned Generate into Reconnect model.
          <Notice
            role="alert"
            tone="negative"
            label="The draft was not written"
            onDismiss={() => commitDrafts.clearError(cwd)}
            action={
              <Action size="xs" onClick={() => void draft()}>
                Retry
              </Action>
            }
          >
            <p className="text-label leading-snug text-muted-foreground">{draftState.error}</p>
          </Notice>
        ) : draftState.result?.warnings.length ? (
          <Notice
            tone="caution"
            label={`${draftState.result.warnings.length} sensitive ${draftState.result.warnings.length === 1 ? "file" : "files"} left out of the draft`}
          >
            <ul className="max-h-20 overflow-y-auto text-label leading-snug text-muted-foreground">
              {draftState.result.warnings.map((warning) => (
                <li key={warning} className="truncate" title={warning}>
                  {warning}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {/* One row, never wrapping: Generate's word and the shortcut hint go
            before the primary action does. Which model drafts, and how hard
            it reads, are Settings › Models; the row holds only the two
            actions, Generate in the quiet foreground and Commit lit. */}
        <div className="@container/commit flex items-center gap-2 px-1.5 pb-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {drafting ? (
              <>
                <span role="status" className="flex h-6 items-center gap-1.5 px-1.5 text-ui font-medium text-muted-foreground">
                  <DraftMark active />
                  <span className="truncate @max-[22rem]/commit:hidden">Drafting...</span>
                </span>
                <Action size="xs" onClick={() => void commitDrafts.cancel(cwd)}>
                  Cancel
                </Action>
              </>
            ) : hasModel && disconnected ? (
              <Action
                size="xs"
                tone="quiet"
                aria-label="Choose a commit model"
                title={connection.reason}
                onClick={openModelSettings}
              >
                <DraftMark />
                Choose model
              </Action>
            ) : hasModel ? (
              <Action
                size="xs"
                tone="quiet"
                aria-label="Draft a message from the diff"
                title={`Generate with ${modelLabel ?? model} · ${formatChord(draftKeys).join(" ")}`}
                disabled={total === 0 || busy}
                onClick={() => void draft()}
              >
                <DraftMark />
                <span className="@max-[22rem]/commit:hidden">Generate</span>
              </Action>
            ) : (
              <Action
                size="xs"
                tone="quiet"
                aria-label="Connect commit model"
                onClick={openModelSettings}
              >
                <DraftMark />
                Connect model
              </Action>
            )}
          </div>

          {/* The chord is part of the button, so it wears the button's
              colours: on the lit fill the caps are a tint of that fill
              (`inverted`), never the card's raised surface with its own
              ring, which once punched two dark holes through the white
              pill. The caps sit 3px from the top and bottom, so the right
              edge is 4px, not the word's 8px; when the row is too narrow
              for the chord the padding evens back out. */}
          {/* Commit, and behind its chevron the two motions that follow it
              most: push, or open the pull request form. */}
          <span className={cn("flex items-stretch rounded-md transition-colors duration-150", !armed && "bg-foreground/[0.06]")}>
            <Action
              tone={armed ? "solid" : "ghost"}
              size="xs"
              disabled={!armed || busy || drafting || total === 0}
              onClick={() => void commit()}
              className={cn("gap-1.5 rounded-r-none pl-2 tabular", armed ? "pr-1 @max-[26rem]/commit:pr-2" : "pr-2 disabled:opacity-100 disabled:text-faint")}
            >
              {commitLabel}
              {/* The chord is shown once there's a message to commit. */}
              {armed ? <span className="contents @max-[26rem]/commit:hidden">
                <Keys keys={formatChord("mod+enter")} inverted />
              </span> : null}
            </Action>
            <Menu modal={false}>
              <MenuTrigger asChild>
                <Action
                  tone={armed ? "solid" : "ghost"}
                  size="xs"
                  aria-label="More ways to commit"
                  disabled={!armed || busy || drafting || total === 0}
                  className={cn("rounded-l-none border-l px-1 [&_svg]:size-3", armed ? "border-background/20" : "border-foreground/10 disabled:opacity-100 disabled:text-faint")}
                >
                  <ChevronDownIcon />
                </Action>
              </MenuTrigger>
              <MenuContent align="end" side="top" className="min-w-56">
                <MenuItem onSelect={() => void commit("push")}>
                  <ArrowUpIcon className="size-3.5 text-faint" />
                  Commit and push
                </MenuItem>
                <ReasonedItem icon={GitPullRequestIcon} reason={pullBlocked} onSelect={() => void commit("pull")}>
                  Commit and open pull request
                </ReasonedItem>
              </MenuContent>
            </Menu>
          </span>
        </div>
      </div>
      </BorderBeam>
    </div>
  )
}

/**
 * One row of the card set apart by a hairline: a label in the notice's
 * colour, an optional action and dismiss on the right, and whatever the
 * notice has to show beneath. Hue is meaning here — negative for a failure,
 * caution for files left out — and only on the label; the detail beneath is
 * muted text, so a long host message never becomes a red paragraph.
 */
function Notice({
  label,
  tone = "neutral",
  action,
  onDismiss,
  role,
  children,
}: {
  label: string
  tone?: "neutral" | "negative" | "caution"
  action?: ReactNode
  onDismiss?: () => void
  role?: "alert" | "status"
  children?: ReactNode
}) {
  return (
    <SharedNotice
      surface="flush"
      tone={tone === "negative" ? "danger" : tone === "caution" ? "caution" : "success"}
      title={label}
      trailing={action}
      onDismiss={onDismiss}
      role={role}
      className="mx-1 rounded-none border-t border-hairline"
      data-commit-notice={tone}
    >
      {children}
    </SharedNotice>
  )
}

/**
 * Generate wears Mako's own thinking orb, the mark the rail and the
 * transcript already use for an agent at work. `shaping` rests as a dotted
 * ring — the one orb state whose first frame reads as a glyph at this size
 * — and morphs only while a draft is being written, so the icon is also the
 * progress. The 20px preset is the library's smallest tuned design; it is
 * not scaled. The library stops itself offscreen, when the document hides,
 * and under reduced motion.
 */
const openModelSettings = () =>
  window.dispatchEvent(new CustomEvent("mako:settings", { detail: "models" }))

function DraftMark({ active = false }: { active?: boolean }) {
  return (
    <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
      <Orb state="shaping" size={20} paused={!active} />
    </span>
  )
}

export function GitRemoteNotice({ cwd, branch }: { cwd: string; branch: string }) {
  const state = useGitPush(cwd, branch)
  const behind = useSession(s => s.git?.behind ?? 0)
  const conflicts = useSession(s => s.git?.files.filter(file => file.status === "conflicted").length ?? 0)
  if (state.kind !== "failed" || conflicts) return null
  if (state.reason === "incoming" && behind === 0 || state.reason === "conflicts") return null
  return <GitRemoteProblem key={`${state.message}:${state.detail ?? ""}`} message={state.reason === "dirty" ? "Local edits overlap incoming changes." : state.message} detail={state.detail} copyContext={state.reason === "untracked" || state.reason === "dirty"} />
}

function GitRemoteProblem({ message, detail, copyContext }: { message: string; detail?: string; copyContext: boolean }) {
  return <SharedNotice
    tone="caution"
    title={message}
    className="mx-2 mb-2"
    data-git-remote-notice
    trailing={copyContext || detail ? <>{copyContext ? <CopyGitContextButton /> : null}{detail ? <GitDetailsButton detail={detail} /> : null}</> : undefined}
  />
}
