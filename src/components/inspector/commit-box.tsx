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
import { Action, IconAction, Keys, Segmented } from "@/components/ui/kit"
import { Notice as SharedNotice } from "@/components/ui/notice"
import { formatChord } from "@/extend/commands"
import { git } from "@/state/git"
import { actions, useSession } from "@/state/session"
import { usePrefs } from "@/state/prefs"
import { commitDrafts, useCommitDraft } from "@/state/commit-drafts"
import { refreshCommitModel, useResolvedCommitModel } from "@/state/commit-model"
import { ArrowDownIcon, ArrowUpIcon, RefreshCwIcon, CheckIcon, ChevronDownIcon, Settings2Icon } from "lucide-react"
import { Orb } from "@/components/ui/orb/orb"
import { useOrbTheme } from "@/components/ui/use-orb-theme"
import { BorderBeam } from "border-beam"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import type { CommitAnalysisMode } from "@/lib/types"
import { useGitPush } from "@/state/git-push"
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
  return <div data-git-footer className="shrink-0 border-t border-hairline">
    {root && status.branch ? <>
      <div data-git-actions data-repository={root} className="flex min-h-8 items-center gap-2 px-2.5">
        <span className="min-w-0 flex-1 truncate text-label text-muted-foreground" title={`${root} · ${status.branch}`}>{root.split("/").filter(Boolean).at(-1)}</span>
        {status.head ? <PushControl cwd={root} branch={status.branch} ahead={status.ahead} upstream={status.upstream} /> : null}
      </div>
      {!resolving ? <GitRemoteNotice cwd={root} branch={status.branch} /> : null}
    </> : null}
    <CommitEditor staged={staged} total={total} />
  </div>
}

function CommitEditor({
  staged,
  total,
}: {
  staged: number
  total: number
}) {
  const cwd = useSession((state) => state.git?.root ?? state.git?.cwd ?? state.meta?.cwd ?? "")
  const draftState = useCommitDraft(cwd)
  const message = draftState.text
  const drafting = draftState.requestId !== null
  const theme = useOrbTheme()
  const pref = usePrefs((prefs) => prefs.commitModel)
  const { model, status: connection } = useResolvedCommitModel(pref)
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

  useLayoutEffect(() => {
    const node = field.current
    if (!node) return
    node.style.height = "0px"
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`
  }, [message])

  // The connections are read when the box appears, when the window comes
  // back (Settings may have changed them) and whenever the preference moves.
  useEffect(() => {
    void refreshCommitModel()
    const focus = () => void refreshCommitModel()
    window.addEventListener("focus", focus)
    return () => window.removeEventListener("focus", focus)
  }, [pref])

  const draft = useCallback(
    async function draftCommitMessage() {
      if (drafting || busy || !cwd || !total) return
      if (!hasModel || disconnected) {
        window.dispatchEvent(
          new CustomEvent("mako:settings", { detail: "commits" })
        )
        return
      }
      await commitDrafts.generate(cwd)
    },
    [drafting, busy, cwd, total, hasModel, disconnected]
  )

  const commit = useCallback(
    async function commitChanges() {
      if (operation || conflicts.length || pushState.kind === "syncing" || !message.trim() || committing.current || busy || drafting) return
      committing.current = true
      setBusy(true)
      try {
        await git.commit(message.trim())
        commitDrafts.committed(cwd, draftState.revision)
        await actions.refreshGit()
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
    [busy, message, drafting, cwd, draftState.revision, operation, conflicts.length, pushState.kind]
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

  const openModelSettings = () =>
    window.dispatchEvent(new CustomEvent("mako:settings", { detail: "commits" }))

  if (operation || conflicts.length) return <GitConflictFooter count={conflicts.length} operation={operation} busy={pushState.kind === "syncing"} detail={pushState.kind === "failed" ? pushState.detail : undefined} />

  return (
    <div data-commit-box data-busy={drafting || busy || pushState.kind === "pushing" || undefined} data-drafting={drafting || undefined} className="shrink-0 p-3">
      <BorderBeam size="md" colorVariant="mono" theme={theme} active={drafting} brightness={1.8}>
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
          className="block max-h-40 min-h-16 w-full resize-none bg-transparent px-3 pt-3 pb-1 text-ui leading-5 placeholder:text-faint focus:outline-none disabled:opacity-50"
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
        {/* One row, never wrapping. The model chip is the only thing that
            shrinks; Generate's word and the shortcut hint go before the
            primary action does. Three weights, read left to right: Generate
            is an action and takes the composer chips' `quiet` foreground,
            the model chip is a setting and stays muted with the picker
            chevron every other chooser in the desk wears, and Commit is
            the one lit control. Before this Generate and the model sat in
            the same muted grey and read as two labels. */}
        <div className="@container/commit flex items-center gap-2 px-2 pb-2">
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
                aria-label="Reconnect commit model"
                title={`${model}: ${connection.reason}`}
                onClick={openModelSettings}
              >
                <DraftMark />
                Reconnect model
              </Action>
            ) : hasModel ? (
              <>
                <Action
                  size="xs"
                  tone="quiet"
                  aria-label="Draft a message from the diff"
                  title={`Generate (${draftState.mode}) with ${model} · ${formatChord(draftKeys).join(" ")}`}
                  disabled={total === 0 || busy}
                  onClick={() => void draft()}
                >
                  <DraftMark />
                  <span className="@max-[22rem]/commit:hidden">Generate</span>
                </Action>
                <GenerationSettings
                  model={model ?? ""}
                  mode={draftState.mode}
                  disabled={busy}
                  onMode={(mode) => commitDrafts.setMode(cwd, mode)}
                  onChangeModel={openModelSettings}
                />
              </>
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
          <Action
            tone={armed ? "solid" : "ghost"}
            size="xs"
            disabled={!armed || busy || drafting || total === 0}
            onClick={() => void commit()}
            className="gap-1.5 pl-2 pr-1 tabular @max-[26rem]/commit:pr-2"
          >
            {commitLabel}
            <span className="contents @max-[26rem]/commit:hidden">
              <Keys keys={formatChord("mod+enter")} inverted={armed} />
            </span>
          </Action>
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
function DraftMark({ active = false }: { active?: boolean }) {
  return (
    <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
      <Orb state="shaping" size={20} paused={!active} />
    </span>
  )
}

const MODE_TEXT = {
  fast: "Reads the whole diff in one pass with low reasoning effort.",
  deep: "Reads the whole diff with higher reasoning effort and looks at the source files where the diff alone is unclear.",
} satisfies Record<CommitAnalysisMode, string>

/**
 * The model chip opens how a draft is generated: which model, and how hard
 * it thinks. Fast/Deep sat in the toolbar row before, where it was a third
 * control competing with Generate and the Commit button for a 300px row.
 */
function GenerationSettings({
  model,
  mode,
  disabled,
  onMode,
  onChangeModel,
}: {
  model: string
  mode: CommitAnalysisMode
  disabled: boolean
  onMode: (mode: CommitAnalysisMode) => void
  onChangeModel: () => void
}) {
  const shortName = model.split("/").slice(1).join("/") || model
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Action
          aria-label={`Drafting model: ${model}. Generation settings`}
          title={model}
          size="xs"
          className="min-w-20 shrink gap-1 aria-expanded:bg-fill-selected aria-expanded:text-foreground"
        >
          <Settings2Icon className="mr-0.5" />
          <span className="truncate">{shortName}</span>
          {/* The picker's chevron, as on the composer's agent and model
              chips; the first thing to go when the row is short of room. */}
          <ChevronDownIcon className="size-3! text-faint/70 @max-[22rem]/commit:hidden" />
        </Action>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-64 gap-3 p-3" aria-label="Commit generation settings">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-label text-faint">Drafting model</p>
            <p className="truncate text-ui font-medium" title={model}>{shortName}</p>
          </div>
          <Action size="xs" tone="outline" onClick={onChangeModel}>
            Change
          </Action>
        </div>
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-label text-faint">Analysis</span>
            <Segmented
              label="Commit analysis mode"
              value={mode}
              options={[{ value: "fast", label: "Fast" }, { value: "deep", label: "Deep" }]}
              disabled={disabled}
              onChange={onMode}
            />
          </div>
          <p className="mt-1.5 text-label leading-snug text-muted-foreground">{MODE_TEXT[mode]}</p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Remote actions follow the selected repository above the shared commit editor. */
export function PushControl({ cwd, branch, ahead, upstream }: { cwd: string; branch: string; ahead: number; upstream?: string }) {
  const state = useGitPush(cwd, branch)
  const behind = useSession(s => s.git?.behind ?? 0)
  const operation = useSession(s => s.git?.operation)
  const conflicts = useSession(s => s.git?.files.some(file => file.status === "conflicted") ?? false)
  const pending = state.kind === "pushing" || state.kind === "syncing"
  const keepEdits = state.kind === "failed" && state.reason === "dirty"
  const style = "h-6 gap-1 px-1.5 text-label font-normal tabular text-faint hover:text-foreground disabled:opacity-50 [&_svg]:size-3"
  if (operation) return <span data-push-control className="flex shrink-0 items-center gap-1">
    <Action size="xs" className={style} disabled={pending} onClick={() => void git.remote("abort")}>Abort {operation}</Action>
    <Action size="xs" className={style} disabled={pending || conflicts} onClick={() => void git.remote("continue")}>{state.kind === "syncing" ? "Working…" : `Continue ${operation}`}</Action>
  </span>
  return <span data-push-control className="flex shrink-0 items-center gap-1">
    <IconAction size="xs" label="Fetch remote changes" disabled={pending} onClick={() => void git.remote("fetch")}><RefreshCwIcon className={state.kind === "syncing" && state.action === "fetch" ? "animate-spin motion-reduce:animate-none" : ""} /></IconAction>
    {behind > 0 ? <Action size="xs" className={style} disabled={pending || conflicts} aria-label={keepEdits ? `Pull ${behind} incoming commits with stash` : ahead > 0 ? `Pull and merge ${behind} incoming commits` : `Pull ${behind} incoming commits`} title={keepEdits ? "Temporarily stash your edits, pull, then restore them. Restoring may cause conflicts; staged edits return unstaged." : ahead > 0 ? "Merge incoming commits into this branch, preserving both histories" : "Pull incoming commits"} onClick={() => void git.remote(keepEdits ? "merge_autostash" : ahead > 0 ? "merge" : "pull")}>
      <ArrowDownIcon />{state.kind === "syncing" ? "Pulling…" : keepEdits ? `Pull with stash ${behind}` : ahead > 0 ? `Pull & merge ${behind}` : `Pull ${behind}`}
    </Action> : null}
    {behind === 0 && (ahead > 0 || !upstream || state.kind === "pushed" || state.kind === "pushing") ? <Action size="xs" className={style} data-push-state={state.kind} aria-label={`Push to ${branch}`} aria-busy={state.kind === "pushing"} disabled={pending || state.kind === "pushed" || behind > 0 || conflicts} title={behind > 0 ? "Pull incoming commits before pushing" : upstream ? `Push ${ahead} commits to ${upstream}` : `Publish ${branch} to origin`} onClick={() => void git.push()}>
      {state.kind === "pushed" ? <CheckIcon /> : <ArrowUpIcon />}
      <span role="status" className="git-action-label" key={state.kind}>{state.kind === "pushing" ? `Pushing ${ahead}…` : state.kind === "pushed" ? "Pushed" : upstream ? `Push ${ahead}` : "Publish branch"}</span>
    </Action> : null}
  </span>
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
