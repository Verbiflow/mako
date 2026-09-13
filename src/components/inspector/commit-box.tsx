import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { Action, Keys, Segmented } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { git } from "@/state/git"
import { actions, useSession } from "@/state/session"
import { usePrefs } from "@/state/prefs"
import { commitDrafts, useCommitDraft } from "@/state/commit-drafts"
import { CheckIcon, GitBranchIcon, Settings2Icon, SparklesIcon, UploadIcon } from "lucide-react"
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
 * What the commit will contain is said once, on the Commit button, with the
 * count ticking in place; the placeholder repeats it only while the field is
 * empty. Nothing here disables while a stage write is in flight: the engine
 * queues every index write and the commit itself per repository, so a commit
 * clicked mid-staging runs after the write and includes it.
 */
export function CommitBox({
  staged,
  total,
}: {
  staged: number
  total: number
}) {
  const cwd = useSession((state) => state.git?.cwd ?? state.meta?.cwd ?? "")
  const draftState = useCommitDraft(cwd)
  const message = draftState.text
  const drafting = draftState.requestId !== null
  const model = usePrefs((prefs) => prefs.commitModel)
  const hasModel = Boolean(model && model !== "current" && model !== "auto")
  const [busy, setBusy] = useState(false)
  const committing = useRef(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const draftKeys = usePrefs(
    (prefs) => prefs.keybindings["workspace.generate-commit"] ?? "mod+shift+g"
  )

  const ahead = useSession((state) => state.git?.ahead ?? 0)
  const branch = useSession((state) => state.git?.branch)
  const upstream = useSession((state) => state.git?.upstream)
  const head = useSession((state) => state.git?.head)
  const pushState = useGitPush(cwd, branch ?? "")

  useLayoutEffect(() => {
    const node = field.current
    if (!node) return
    node.style.height = "0px"
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`
  }, [message])

  const draft = useCallback(
    async function draftCommitMessage() {
      if (drafting || busy || !cwd || !total) return
      if (!hasModel) {
        window.dispatchEvent(
          new CustomEvent("mako:settings", { detail: "commits" })
        )
        return
      }
      await commitDrafts.generate(cwd)
    },
    [drafting, busy, cwd, total, hasModel]
  )

  const commit = useCallback(
    async function commitChanges() {
      if (!message.trim() || committing.current || busy || drafting) return
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
    [busy, message, drafting, cwd, draftState.revision]
  )

  // What the commit will contain, in one place: the placeholder while the
  // field is empty, the Commit button always.
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
    : total === 0
      ? "Commit"
      : staged > 0
        ? `Commit ${count} ${noun}`
        : `Commit all ${count} ${noun}`

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

  return (
    <div data-commit-box data-busy={drafting || busy || pushState.kind === "pushing" || undefined} className="shrink-0 border-t border-hairline p-3">
      {draftState.error ? (
        <div role="alert" className="mb-2 px-1 text-label text-negative">
          <p>{draftState.error}</p>
          <Action size="xs" onClick={() => void draft()}>
            Retry
          </Action>
          <Action
            size="xs"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("mako:settings", { detail: "commits" })
              )
            }
          >
            Model settings
          </Action>
        </div>
      ) : null}
      {draftState.suggestion ? (
        <div className="mb-2 rounded-md border border-hairline p-2">
          <p className="mb-2 text-label text-faint">
            Your message was kept. Review the generated draft before replacing
            it.
          </p>
          <pre className="max-h-36 overflow-auto font-sans text-ui whitespace-pre-wrap">
            {draftState.suggestion.message}
          </pre>
          <div className="mt-2 flex gap-2">
            <Action
              size="xs"
              tone="outline"
              onClick={() => commitDrafts.accept(cwd)}
            >
              Use generated draft
            </Action>
            <Action size="xs" onClick={() => commitDrafts.dismiss(cwd)}>
              Keep mine
            </Action>
          </div>
        </div>
      ) : null}
      {(draftState.suggestion ?? draftState.result)?.warnings.length ? (
        <details className="mb-2 px-1 text-label text-caution">
          <summary className="pressable cursor-pointer">
            Sensitive file contents excluded
          </summary>
          <ul className="mt-1 max-h-24 overflow-y-auto">
            {(draftState.suggestion ?? draftState.result)?.warnings.map(
              (warning) => (
                <li key={warning}>{warning}</li>
              )
            )}
          </ul>
        </details>
      ) : null}
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

        {/* One row, never wrapping. The model chip is the only thing that
            shrinks; Generate's word and the shortcut hint go before the
            primary action does. */}
        <div className="@container/commit flex items-center gap-2 px-2 pb-2">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {drafting ? (
              <>
                <Action size="xs" onClick={() => void commitDrafts.cancel(cwd)}>
                  Cancel
                </Action>
                <span role="status" className="truncate text-label text-faint">
                  Drafting...
                </span>
              </>
            ) : hasModel ? (
              <>
                <Action
                  size="xs"
                  aria-label="Draft a message from the diff"
                  title={`Generate (${draftState.mode}) with ${model} · ${formatChord(draftKeys).join(" ")}`}
                  disabled={total === 0 || busy}
                  onClick={() => void draft()}
                >
                  <SparklesIcon />
                  <span className="@max-[22rem]/commit:hidden">Generate</span>
                </Action>
                <div
                  className="shrink-0"
                  title={draftState.mode === "fast" ? "Complete evidence coverage with low reasoning effort and direct synthesis." : "Complete evidence coverage with higher reasoning effort and optional source checks."}
                >
                  <Segmented
                    label="Commit analysis mode"
                    value={draftState.mode}
                    options={[{ value: "fast", label: "Fast" }, { value: "deep", label: "Deep" }]}
                    disabled={drafting || busy}
                    onChange={(mode) => commitDrafts.setMode(cwd, mode)}
                  />
                </div>
                <Action
                  aria-label={`Drafting model: ${model}. Open model settings`}
                  title={model}
                  size="xs"
                  className="min-w-20 shrink"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("mako:settings", { detail: "commits" })
                    )
                  }
                >
                  <Settings2Icon />
                  <span className="truncate">{model?.split("/").slice(1).join("/") ?? "Model settings"}</span>
                </Action>
              </>
            ) : (
              <Action
                size="xs"
                aria-label="Connect commit model"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("mako:settings", { detail: "commits" })
                  )
                }
              >
                <SparklesIcon />
                Connect model
              </Action>
            )}
          </div>

          <Action
            tone={message.trim() ? "solid" : "ghost"}
            size="xs"
            disabled={!message.trim() || busy || drafting || total === 0}
            onClick={() => void commit()}
            className="gap-1.5 tabular"
          >
            {commitLabel}
            <span className="contents @max-[26rem]/commit:hidden">
              <Keys keys={formatChord("mod+enter")} />
            </span>
          </Action>
        </div>
      </div>
      {head && branch ? <PushControl cwd={cwd} branch={branch} ahead={ahead} upstream={upstream} disabled={busy} /> : null}
    </div>
  )
}

/**
 * Pushing publishes work outside the machine, so it stays a deliberate,
 * separately-labelled action and never rides along with a commit.
 */
function PushControl({ cwd, branch, ahead, upstream, disabled }: { cwd: string; branch: string; ahead: number; upstream?: string; disabled: boolean }) {
  const state = useGitPush(cwd, branch)
  const pending = state.kind === "pushing"
  const pushed = state.kind === "pushed" && ahead === 0
  const complete = pushed || (state.kind === "idle" && Boolean(upstream) && ahead === 0)
  return <div className="mt-1.5 flex h-7 items-center gap-2 pl-2 pr-1" data-push-control>
    <GitBranchIcon className="size-3.5 shrink-0 text-faint" />
    <span className="min-w-0 flex-1 truncate text-label text-faint tabular" title={upstream ?? branch}>{branch}{ahead > 0 ? ` · ${ahead} ${ahead === 1 ? "commit" : "commits"} ready` : ""}</span>
    <Action tone={pending ? "outline" : "ghost"} size="xs" className="disabled:opacity-100" data-push-state={state.kind} aria-label={`Push to ${branch}`} aria-busy={pending} disabled={disabled || pending || complete} title={state.kind === "failed" ? state.message : upstream ? `Push to ${upstream}` : `Publish ${branch} to origin`} onClick={() => void git.push()}>
      {complete ? <CheckIcon /> : <UploadIcon />}
      {/* The branch is the row's subject already, so the button does not repeat it. */}
      <span role="status" className="git-action-label" key={state.kind}>{pending ? "Pushing..." : pushed ? "Pushed" : complete ? "Up to date" : state.kind === "failed" ? "Retry push" : "Push"}</span>
    </Action>
  </div>
}
