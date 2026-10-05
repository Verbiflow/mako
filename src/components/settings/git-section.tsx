import { useEffect, useState, type ReactNode } from "react"
import { RotateCcwIcon } from "lucide-react"
import { Action, Keys, ListCard, Segmented, SettingRow, Toggle } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { cn } from "@/lib/utils"
import type { Prefs } from "@/state/prefs"
import { setPref, usePrefs } from "@/state/prefs"
import { git } from "@/state/git"
import { refreshCommitModel, useResolvedCommitModel } from "@/state/commit-model"
import { WorktreesSection } from "./worktrees-section"

/** Settings › Git: how Changes looks, what writes commit messages, and worktrees. */
export function GitSection() {
  return (
    <div className="flex flex-col gap-8">
      <ChangesView />
      <Writing />
      <section className="flex flex-col gap-3">
        <h3 className="text-ui font-medium">Worktrees</h3>
        <WorktreesSection />
      </section>
    </div>
  )
}

function ChangesView() {
  const layout = usePrefs((prefs) => prefs.changesLayout)
  const diffStyle = usePrefs((prefs) => prefs.diffStyle)
  const wrapDiff = usePrefs((prefs) => prefs.wrapDiff)
  const filesView = usePrefs((prefs) => prefs.filesView)
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-ui font-medium">Changes</h3>
        <p className="mt-0.5 text-label text-muted-foreground">How the Changes panel shows your working tree. Both commit, push and open pull requests the same way.</p>
      </div>
      <div role="radiogroup" aria-label="Changes layout" className="grid grid-cols-2 gap-3">
        <LayoutChoice value="review" chosen={layout} title="Review" description="Every changed file's diff in one scroll. Commit what you see.">
          <ReviewPicture />
        </LayoutChoice>
        <LayoutChoice value="files" chosen={layout} title="Files" description="A tree with staging on each file, and one file's diff.">
          <FilesPicture />
        </LayoutChoice>
      </div>
      <ListCard>
        <SettingRow title="Diff style" description="Side by side needs a wide panel; maximize Changes into the center for it.">
          <Segmented
            label="Diff style"
            value={diffStyle}
            options={[{ value: "unified", label: "Unified" }, { value: "split", label: "Side by side" }]}
            onChange={(next) => setPref("diffStyle", next)}
          />
        </SettingRow>
        <SettingRow title="Wrap long lines" description="Off scrolls each line sideways instead.">
          <Toggle label="Wrap long lines" on={wrapDiff} onChange={() => setPref("wrapDiff", !wrapDiff)} />
        </SettingRow>
        <SettingRow title="Files list" description="A folded tree, or each folder once with its files under it.">
          <Segmented
            label="Files list"
            value={filesView}
            options={[{ value: "tree", label: "Tree" }, { value: "folders", label: "By folder" }]}
            onChange={(next) => setPref("filesView", next)}
          />
        </SettingRow>
      </ListCard>
    </section>
  )
}

function LayoutChoice({ value, chosen, title, description, children }: {
  value: Prefs["changesLayout"]
  chosen: Prefs["changesLayout"]
  title: string
  description: string
  children: ReactNode
}) {
  const selected = value === chosen
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={title}
      onClick={() => setPref("changesLayout", value)}
      className={cn(
        "pressable flex flex-col gap-3 rounded-lg p-3 text-left transition-[background-color,box-shadow] duration-150 ease-[var(--ease-out)]",
        selected
          ? "bg-fill-selected [box-shadow:inset_0_0_0_1px_var(--border)]"
          : "bg-shell/55 [box-shadow:inset_0_0_0_0.5px_var(--hairline)] hover:bg-fill-hover"
      )}
    >
      <span aria-hidden className="block h-28 overflow-hidden rounded-md bg-surface [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
        {children}
      </span>
      <span>
        <span className="flex items-center gap-2 text-ui font-medium">
          <span className={cn("flex size-3 items-center justify-center rounded-full ring-1 ring-inset", selected ? "ring-foreground" : "ring-border")}>
            {selected ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
          </span>
          {title}
        </span>
        <span className="mt-1 block text-label leading-relaxed text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}

type PictureLine = "add" | "remove" | "same"

function PictureLines({ lines }: { lines: readonly PictureLine[] }) {
  return lines.map((line, index) => (
    <span key={index} className={cn("flex h-2 items-center px-1.5", line === "add" ? "bg-added/15" : line === "remove" ? "bg-removed/15" : "")}>
      <span className={cn("h-0.5 rounded-full", line === "same" ? "w-10 bg-foreground/15" : line === "add" ? "w-14 bg-added/50" : "w-9 bg-removed/50")} />
    </span>
  ))
}

/** Two files' headers, each over a few added and removed lines. */
function ReviewPicture() {
  const file = (lines: readonly PictureLine[]) => (
    <span className="block">
      <span className="flex h-3 items-center gap-1 border-b border-hairline px-1.5">
        <span className="h-1 w-1 rounded-full bg-caution/70" />
        <span className="h-1 w-12 rounded-full bg-foreground/25" />
        <span className="ml-auto h-1 w-4 rounded-full bg-foreground/15" />
      </span>
      <PictureLines lines={lines} />
    </span>
  )
  return (
    <span className="flex flex-col gap-1 p-1.5">
      {file(["same", "remove", "add", "add", "same"])}
      {file(["same", "add", "add", "same"])}
    </span>
  )
}

/** A short tree with checkboxes over one file's diff. */
function FilesPicture() {
  const rows = [{ depth: 0, dir: true }, { depth: 1, dir: false }, { depth: 1, dir: false }, { depth: 0, dir: false }]
  return (
    <span className="flex h-full flex-col">
      <span className="flex flex-col gap-1 p-1.5">
        {rows.map((row, index) => (
          <span key={index} className="flex h-2 items-center gap-1" style={{ paddingInlineStart: row.depth * 8 }}>
            <span className={cn("size-1.5 rounded-[2px] ring-1 ring-inset", index === 1 ? "bg-foreground/60 ring-foreground/60" : "ring-foreground/30")} />
            <span className={cn("h-1 rounded-full", row.dir ? "w-8 bg-foreground/20" : "w-12 bg-foreground/30")} />
          </span>
        ))}
      </span>
      <span className="mt-auto block border-t border-hairline py-1">
        <PictureLines lines={["same", "remove", "add", "same"]} />
      </span>
    </span>
  )
}

/** The person's commit rules, and which model writes with them. */
function Writing() {
  const stored = usePrefs((prefs) => prefs.commitPrompt)
  const draftKeys = usePrefs((prefs) => prefs.keybindings["workspace.generate-commit"] ?? "mod+shift+g")
  const { model, label, status } = useResolvedCommitModel()
  const [fallback, setFallback] = useState("")
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => {
    void git.defaultPrompt().then(setFallback, () => setFallback(""))
    void refreshCommitModel()
  }, [])
  const value = draft ?? stored ?? fallback
  const customized = Boolean(stored && stored !== fallback)
  const writer = status.kind === "disconnected" ? status.reason : model ? label ?? model : "No model can write them yet"
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-ui font-medium">Writing</h3>
        <p className="mt-0.5 text-label text-muted-foreground">
          Commit messages and pull request descriptions are drafted from the exact diff, with sensitive files left
          out and named. Pull requests follow the repository's template when it has one.
        </p>
      </div>
      <ListCard>
        <SettingRow title="Written by" description={writer}>
          <Action tone="outline" size="xs" onClick={() => window.dispatchEvent(new CustomEvent("mako:settings", { detail: "models" }))}>
            Change in Models
          </Action>
        </SettingRow>
      </ListCard>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <label htmlFor="commit-instructions" className="text-ui font-medium">Commit instructions</label>
          <span className="text-label text-faint">{customized ? "Customized" : "Default"}</span>
          <span className="ml-auto flex items-center gap-1 text-label text-faint">
            <Keys keys={formatChord(draftKeys)} /> drafts
          </span>
        </div>
        <textarea
          id="commit-instructions"
          aria-label="Commit instructions"
          value={value}
          spellCheck={false}
          rows={8}
          maxLength={12_000}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft !== null) setPref("commitPrompt", draft.trim() ? draft : undefined)
            setDraft(null)
          }}
          className="w-full resize-y rounded-lg bg-raised px-2.5 py-2 font-mono text-ui leading-relaxed ring-1 ring-hairline focus:outline-none focus-visible:ring-border"
        />
        <div>
          <Action
            tone="ghost"
            size="xs"
            disabled={!customized}
            onClick={() => {
              setDraft(null)
              setPref("commitPrompt", undefined)
            }}
          >
            <RotateCcwIcon />
            Restore default
          </Action>
        </div>
      </div>
    </section>
  )
}
