import { useEffect } from "react"
import { PlusIcon, RefreshCwIcon } from "lucide-react"
import { Action, Chip, Segmented, Toggle } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Shimmer } from "@/components/ui/shimmer"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { homeRelative } from "@/lib/skill-matrix"
import { cn } from "@/lib/utils"
import type { AuthoringDraft, AuthoringEntry, AuthoringPlan, AuthoringSource, AuthoringView } from "@/lib/types"
import { authoring, useAuthoring, type AuthoringEditor } from "@/state/native-authoring"
import { AUTHORING_SCOPES } from "@/lib/authoring-scopes"
import { Hint, PlanPanel, TrustChip } from "./authoring-plan"

/**
 * Each agent's own hooks and commands, in every file the agent reads them
 * from and in the agent's order. A change is previewed as the diff of the
 * one file it writes, then applied; the file as it was is kept first.
 */
export function NativeAuthoringSection() {
  const status = useAuthoring((state) => state.status)
  const catalog = useAuthoring((state) => state.catalog)
  const provider = useAuthoring((state) => state.provider)
  const family = useAuthoring((state) => state.family)
  const error = useAuthoring((state) => state.error)
  const notice = useAuthoring((state) => state.notice)

  useEffect(() => { void authoring.load() }, [])

  const providers = catalog ? [...new Map(catalog.views.map((view) => [view.provider, view.label])).entries()] : []
  const view = catalog?.views.find((entry) => entry.provider === provider && entry.family === family) ?? null
  const count = (harness: string) => catalog?.views.filter((entry) => entry.provider === harness && entry.family !== "mcp").reduce((sum, entry) => sum + entry.entries.length, 0) ?? 0

  return (
    <div className="flex flex-col gap-4">
      <p className="text-ui leading-relaxed text-muted-foreground">
        Each agent&apos;s own hooks and commands, read from every file the agent reads them from, in its order. Mako
        changes only the entry you edit, shows the diff of the file first, and keeps the file as it was. Hooks run
        with the agent&apos;s permissions; nothing here runs one.
      </p>
      {status === "loading" && !catalog ? <p className="text-ui text-faint"><Shimmer text="Reading each agent's configuration…" /></p> : null}
      {catalog ? (
        <>
          <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Agent">
            {providers.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-label={label}
                aria-selected={id === provider}
                onClick={() => authoring.select(id, family)}
                className={cn(
                  "pressable flex h-7 items-center gap-1.5 rounded-md px-2 text-ui",
                  id === provider ? "bg-fill-selected text-foreground" : "text-muted-foreground hover:bg-fill-hover hover:text-foreground"
                )}
              >
                <HarnessIcon harness={id} className="size-3.5" />
                {label}
                {count(id) ? <span className="text-label text-faint">{count(id)}</span> : null}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Segmented
              label="What to edit"
              value={family === "commands" ? "commands" : "hooks"}
              options={[{ value: "hooks", label: "Hooks" }, { value: "commands", label: "Commands" }]}
              onChange={(next) => { if (provider) authoring.select(provider, next) }}
            />
            <span className="flex-1" />
            <Action tone="ghost" size="xs" onClick={() => void authoring.refresh()}>
              <RefreshCwIcon className="size-3" />
              Read again
            </Action>
          </div>
          {view ? <ViewBody view={view} /> : null}
        </>
      ) : null}
      {error ? <p role="alert" className="whitespace-pre-wrap text-ui text-negative">{error}</p> : null}
      {notice ? <p role="status" className="text-ui text-muted-foreground">{notice}</p> : null}
    </div>
  )
}

function ViewBody({ view }: { view: AuthoringView }) {
  const editor = useAuthoring((state) => state.editor)
  if (view.absent) {
    return (
      <div className="rounded-lg bg-surface px-4 py-6 ring-1 ring-hairline">
        <p className="text-ui font-medium">{view.absent.by === "harness" ? `${view.label} has no ${view.family} of its own` : `Mako doesn't edit ${view.label}'s ${view.family} yet`}</p>
        <p className="mt-1 max-w-[46rem] text-label leading-relaxed text-muted-foreground">{view.absent.reason}.</p>
      </div>
    )
  }
  // Sources that hold something, and the ones a new entry can go in.
  const holds = (source: AuthoringSource) => view.entries.some((entry) => entry.sourceId === source.id)
  const shown = view.sources.filter((source) => !source.switches && (holds(source) || source.problem || (source.writable.supported && view.operations.create.supported && source.scope !== "managed")))
  return (
    <div className="flex flex-col gap-3">
      <p className="text-label leading-relaxed text-faint">{view.precedence} {view.reload}</p>
      {shown.map((source) => (
        <SourceCard key={source.id} view={view} source={source} entries={view.entries.filter((entry) => entry.sourceId === source.id)} editor={editor} />
      ))}
      {!shown.length ? <p className="text-ui text-faint">No file this agent reads {view.family} from exists yet.</p> : null}
    </div>
  )
}

function SourceCard({ view, source, entries, editor }: { view: AuthoringView; source: AuthoringSource; entries: AuthoringEntry[]; editor: AuthoringEditor | null }) {
  const plan = useAuthoring((state) => state.plan)
  const creating = editor?.mode === "create" && editor.sourceId === source.id
  const canCreate = view.operations.create.supported && source.writable.supported && !source.problem
  return (
    <section aria-label={source.label} className="rounded-lg bg-surface ring-1 ring-hairline">
      <header className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
        <Chip>{AUTHORING_SCOPES[source.scope]}</Chip>
        <span className="min-w-0 flex-1 truncate font-mono text-label text-muted-foreground" title={source.path}>{homeRelative(source.path)}</span>
        {source.trust ? <TrustChip state={source.trust.state} detail={source.trust.detail} /> : null}
        {!source.writable.supported ? <Hint label="Read-only" detail={source.writable.reason} /> : null}
        {source.off ? <Hint label={`Off: ${source.off.key}`} detail={source.off.detail} tone="caution" /> : null}
        {canCreate ? (
          <Action size="xs" disabled={Boolean(editor)} onClick={() => authoring.edit({ mode: "create", sourceId: source.id, draft: blankDraft(view) })}>
            <PlusIcon className="size-3" />
            {view.form === "hook" ? "Hook" : view.form === "module" ? "Plugin" : "Command"}
          </Action>
        ) : null}
      </header>
      {source.problem ? <p className="px-3 py-2 text-label text-negative">{source.problem}</p> : null}
      {!entries.length && !creating && !source.problem ? <p className="px-3 py-2.5 text-label text-faint">{source.exists ? "Nothing here yet." : "This file doesn't exist yet; adding the first entry creates it."}</p> : null}
      <div className="divide-y divide-hairline">
        {entries.map((entry) => editor?.mode === "edit" && editor.entryId === entry.id
          ? <Editor key={entry.id} view={view} editor={editor} plan={plan} />
          : <EntryRow key={entry.id} view={view} source={source} entry={entry} plan={plan} />)}
        {creating ? <Editor view={view} editor={editor} plan={plan} /> : null}
      </div>
    </section>
  )
}

function EntryRow({ view, source, entry, plan }: { view: AuthoringView; source: AuthoringSource; entry: AuthoringEntry; plan: AuthoringPlan | null }) {
  const busy = useAuthoring((state) => state.busy)
  const editing = useAuthoring((state) => state.editor !== null)
  const writable = source.writable.supported && !source.problem
  const mine = plan && "entryId" in plan.change && plan.change.entryId === entry.id ? plan : null
  const run = entry.hook?.run ?? entry.command?.description ?? entry.module?.text.split("\n").find((line) => line.trim()) ?? ""
  return (
    <div className={cn("px-3 py-2.5", entry.shadowedBy && "opacity-70")}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-ui font-medium">{entry.hook ? entry.hook.event : entry.name}</span>
            {entry.hook?.matcher ? <Chip className="max-w-48 truncate font-mono">{entry.hook.matcher}</Chip> : null}
            {entry.hook && entry.hook.type !== "command" ? <Chip>{entry.hook.type}</Chip> : null}
            {entry.hook?.timeout ? <span className="text-label text-faint">{entry.hook.timeout} s timeout</span> : null}
            {entry.trust ? <TrustChip state={entry.trust.state} detail={entry.trust.detail} /> : null}
            {entry.shadowedBy ? <Hint label="Not used" detail="Another file this agent reads first has a command of the same name, which is the one it runs." /> : null}
          </div>
          {run ? <p className="mt-0.5 truncate font-mono text-label text-muted-foreground" title={run}>{run}</p> : null}
        </div>
        {view.operations.trust.supported && writable && entry.trust && entry.trust.state !== "trusted" && entry.trust.state !== "managed" ? (
          <Action size="xs" tone="outline" disabled={busy || editing} onClick={() => void authoring.preview({ kind: "trust", entryId: entry.id })}>Trust</Action>
        ) : null}
        {view.operations.edit.supported && writable && editableDraft(entry) ? (
          <Action size="xs" disabled={busy || editing} onClick={() => { const draft = editableDraft(entry); if (draft) authoring.edit({ mode: "edit", entryId: entry.id, draft }) }}>Edit</Action>
        ) : null}
        {view.operations.remove.supported && writable ? (
          <Action size="xs" disabled={busy || editing} onClick={() => void authoring.preview({ kind: "remove", entryId: entry.id })}>Remove</Action>
        ) : null}
        {source.off ? <span className="text-label text-faint">Off</span> : view.operations.disable.supported ? (
          <Toggle label={`${entry.enabled ? "Turn off" : "Turn on"} ${entry.name}`} on={entry.enabled} disabled={busy || editing} onChange={() => void authoring.preview({ kind: "enable", entryId: entry.id, enabled: !entry.enabled })} />
        ) : (
          <Tooltip>
            <TooltipTrigger asChild><span className="text-label text-faint">{entry.enabled ? "On" : "Off"}</span></TooltipTrigger>
            <TooltipContent className="max-w-72">{view.operations.disable.supported ? "" : view.operations.disable.reason}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {mine ? <PlanPanel plan={mine} /> : null}
    </div>
  )
}

function blankDraft(view: AuthoringView): AuthoringDraft {
  if (view.form === "command") return { kind: "command", invocation: "", text: "---\ndescription: \n---\n" }
  if (view.form === "module") return { kind: "module", name: "", text: "" }
  const handler = view.hooks?.handlers[0]
  return { kind: "hook", event: view.hooks?.events[0] ?? "", type: handler?.type ?? "command", run: "" }
}

function editableDraft(entry: AuthoringEntry): AuthoringDraft | null {
  if (entry.hook) {
    const draft: AuthoringDraft = { kind: "hook", event: entry.hook.event, type: entry.hook.type, run: entry.hook.run }
    if (entry.hook.matcher !== undefined) draft.matcher = entry.hook.matcher
    if (entry.hook.timeout !== undefined) draft.timeout = entry.hook.timeout
    return draft
  }
  if (entry.command) return { kind: "command", invocation: entry.command.invocation, text: entry.command.text }
  if (entry.module) return { kind: "module", name: entry.name, text: entry.module.text }
  return null
}

const field = "rounded-md bg-background px-2 py-1.5 text-ui text-foreground ring-1 ring-hairline placeholder:text-faint focus:ring-border focus:outline-none disabled:opacity-60"

function Editor({ view, editor, plan }: { view: AuthoringView; editor: AuthoringEditor; plan: AuthoringPlan | null }) {
  const busy = useAuthoring((state) => state.busy)
  const draft = editor.draft
  const mine = plan && (editor.mode === "create" ? plan.change.kind === "create" : "entryId" in plan.change && plan.change.entryId === editor.entryId) ? plan : null
  const submit = () => void authoring.preview(editor.mode === "create" ? { kind: "create", sourceId: editor.sourceId, draft } : { kind: "edit", entryId: editor.entryId, draft })
  const vocabulary = view.hooks
  return (
    <div className="flex flex-col gap-2.5 bg-raised/40 px-3 py-3">
      {draft.kind === "hook" && vocabulary ? (
        <>
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col gap-1 text-label text-muted-foreground">Event
              <select className={field} value={draft.event} disabled={busy} onChange={(event) => authoring.draft({ ...draft, event: event.target.value })}>
                {vocabulary.events.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            {vocabulary.matcher && (!vocabulary.matchers || vocabulary.matchers.includes(draft.event)) ? (
              <label className="flex min-w-48 flex-1 flex-col gap-1 text-label text-muted-foreground">Matcher
                <input className={cn(field, "font-mono")} value={draft.matcher ?? ""} placeholder="Every tool" disabled={busy} onChange={(event) => authoring.draft({ ...draft, matcher: event.target.value })} />
              </label>
            ) : null}
            <label className="flex flex-col gap-1 text-label text-muted-foreground">Runs
              <select className={field} value={draft.type} disabled={busy} onChange={(event) => authoring.draft({ ...draft, type: event.target.value })}>
                {vocabulary.handlers.map((handler) => <option key={handler.type} value={handler.type}>{handler.type}</option>)}
              </select>
            </label>
            <label className="flex w-24 flex-col gap-1 text-label text-muted-foreground">Timeout, s
              <input className={field} inputMode="numeric" value={draft.timeout ?? ""} placeholder="Default" disabled={busy}
                onChange={(event) => { const seconds = Number(event.target.value); authoring.draft({ ...draft, timeout: event.target.value && seconds > 0 ? seconds : undefined }) }} />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-label text-muted-foreground">
            {vocabulary.handlers.find((handler) => handler.type === draft.type)?.run === "url" ? "URL" : vocabulary.handlers.find((handler) => handler.type === draft.type)?.run === "prompt" ? "Prompt" : "Command"}
            <textarea className={cn(field, "min-h-16 resize-y font-mono text-label")} value={draft.run} disabled={busy} spellCheck={false} onChange={(event) => authoring.draft({ ...draft, run: event.target.value })} />
          </label>
        </>
      ) : null}
      {draft.kind === "command" ? (
        <>
          <label className="flex flex-col gap-1 text-label text-muted-foreground">Name, typed after /
            <input className={cn(field, "font-mono")} value={draft.invocation} placeholder="review" disabled={busy || editor.mode === "edit"} onChange={(event) => authoring.draft({ ...draft, invocation: event.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-label text-muted-foreground">Instructions, as the file holds them
            <textarea className={cn(field, "min-h-40 resize-y font-mono text-label leading-relaxed")} value={draft.text} disabled={busy} spellCheck={false} onChange={(event) => authoring.draft({ ...draft, text: event.target.value })} />
          </label>
        </>
      ) : null}
      {draft.kind === "module" ? (
        <>
          <label className="flex flex-col gap-1 text-label text-muted-foreground">File name
            <input className={cn(field, "font-mono")} value={draft.name} placeholder="guard.ts" disabled={busy || editor.mode === "edit"} onChange={(event) => authoring.draft({ ...draft, name: event.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-label text-muted-foreground">Code, as OpenCode loads it
            <textarea className={cn(field, "min-h-48 resize-y font-mono text-label leading-relaxed")} value={draft.text} disabled={busy} spellCheck={false} onChange={(event) => authoring.draft({ ...draft, text: event.target.value })} />
          </label>
        </>
      ) : null}
      {mine ? <PlanPanel plan={mine} /> : (
        <div className="flex gap-2">
          <Action tone="solid" disabled={busy} onClick={submit}>Preview change</Action>
          <Action disabled={busy} onClick={() => authoring.edit(null)}>Cancel</Action>
        </div>
      )}
    </div>
  )
}

