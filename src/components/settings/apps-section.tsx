import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import type { ProjectAppSetup, RecipeVersionView, RecipeView } from "../../../electron/contracts/project-app"
import { environmentRepairPrompt } from "../../../electron/contracts/thread-environments"
import { Action, Blank, Chip, Eyebrow, ListCard, ListCardRow, Toggle } from "@/components/ui/kit"
import { Shimmer } from "@/components/ui/shimmer"
import { recipeChangeContext } from "@/lib/app-setup-context"
import { threadFolderKey } from "@/lib/thread-folders"
import { cn } from "@/lib/utils"
import { appSetupStore, useAppSetup } from "@/state/app-setup"
import { desktop } from "@/state/desktop"
import { setupAgentLabel, startProjectSetup, useSetupAgent } from "@/state/project-setup"
import { actions } from "@/state/session"
import { showSetupFor, threadAppDriver, useThreadApp } from "@/state/thread-app"
import { useThreads } from "@/state/threads"
import { useWorktrees } from "@/state/worktrees"

const HOME = /^\/(?:Users|home)\/[^/]+(?=\/)/
const shortPath = (path: string) => path.replace(HOME, "~")
const folderName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const LISTED = 40

/** The projects the sidebar files Threads under, the ones worked in most recently first. */
function useProjects(): string[] {
  const refs = useThreads((state) => state.threads)
  const folderMap = useWorktrees((state) => state.folderMap)
  return useMemo(() => {
    const latest = new Map<string, number>()
    for (const ref of refs) {
      if (ref.workspaceMissing) continue
      const root = threadFolderKey(ref, folderMap)
      if (!root || !root.startsWith("/")) continue
      const at = Date.parse(ref.updatedAt ?? ref.startedAt ?? "") || 0
      latest.set(root, Math.max(latest.get(root) ?? 0, at))
    }
    return [...latest].sort((a, b) => b[1] - a[1]).slice(0, LISTED).map(([root]) => root)
  }, [refs, folderMap])
}

function close() {
  window.dispatchEvent(new CustomEvent("mako:close-settings"))
}

/** A new Thread in the project with the request written; the person picks the agent and sends it. */
async function newThreadWith(root: string, text: string) {
  close()
  if (!(await actions.newConversationIn(root))) return
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("mako:compose", { detail: { text } })))
}

/** A new Thread with the recipe attached; the person says what to change. */
async function changeWithAgent(setup: ProjectAppSetup) {
  const context = recipeChangeContext(setup)
  if (!context) return
  close()
  if (!(await actions.newConversationIn(setup.root))) return
  requestAnimationFrame(() =>
    window.dispatchEvent(new CustomEvent("mako:attach", {
      detail: {
        files: [{ file: new File([context.text], context.name, { type: "text/markdown" }), contextLabel: context.label }],
        text: () => "",
      },
    }))
  )
}

export function AppsSection() {
  const chosen = useAppSetup((state) => state.chosen)
  return chosen ? (
    <ProjectApp key={chosen} root={chosen} onBack={() => appSetupStore.set({ chosen: undefined })} />
  ) : (
    <ProjectList onOpen={(root) => appSetupStore.set({ chosen: root })} />
  )
}

/* ------------------------------------------------------------------ */
/* Every project                                                       */
/* ------------------------------------------------------------------ */

function ProjectList({ onOpen }: { onOpen: (root: string) => void }) {
  const roots = useProjects()
  const [setups, setSetups] = useState<Record<string, ProjectAppSetup | null>>({})
  const key = roots.join("\n")
  useEffect(() => {
    const setup = threadAppDriver()?.setup
    if (!setup) return
    let live = true
    for (const root of key ? key.split("\n") : [])
      void setup(root).then(
        (found) => live && setSetups((current) => ({ ...current, [root]: found })),
        () => live && setSetups((current) => ({ ...current, [root]: null })),
      )
    return () => { live = false }
  }, [key])

  return (
    <div>
      <p className="pb-4 text-ui leading-relaxed text-muted-foreground">
        How each project’s Threads install, start and check their own copy of
        its app. An agent works this out once and Mako keeps it as the
        project’s recipe, for every branch.
      </p>
      {roots.length ? (
        <ListCard className="px-0">
          {roots.map((root) => (
            <ProjectRow key={root} root={root} setup={setups[root]} onOpen={() => onOpen(root)} />
          ))}
        </ListCard>
      ) : (
        <div className="rounded-lg bg-shell/55 [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
          <Blank title="No projects yet" body="Start a Thread in a project folder and it shows up here." />
        </div>
      )}
    </div>
  )
}

function ProjectRow({ root, setup, onOpen }: { root: string; setup: ProjectAppSetup | null | undefined; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-app-project={folderName(root)}
      onClick={onOpen}
      className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-100 first:rounded-t-lg last:rounded-b-lg hover:bg-fill-hover"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium text-foreground">{setup?.project ?? folderName(root)}</span>
        <span className="mt-0.5 block truncate text-label text-faint">{shortPath(root)}</span>
      </span>
      <ProjectState setup={setup} />
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-faint transition-colors duration-100 group-hover:text-muted-foreground" />
    </button>
  )
}

function ProjectState({ setup }: { setup: ProjectAppSetup | null | undefined }) {
  if (setup === undefined) return <span className="h-[18px] w-16 shrink-0 animate-pulse rounded bg-raised" />
  if (setup === null) return <span className="shrink-0 text-label text-faint">Couldn’t read</span>
  const { recipe, secrets } = setup
  if (recipe.kind === "none") return <Chip>Not set up</Chip>
  if (recipe.kind === "invalid") return <Chip tone="negative">Recipe broken</Chip>
  return (
    <span className="flex shrink-0 items-center gap-2">
      {secrets && !secrets.allowed ? <Chip tone="caution">Credentials not copied</Chip> : null}
      <span className="max-w-[16rem] truncate text-label text-muted-foreground">{runsSummary(recipe.recipe)}</span>
    </span>
  )
}

function runsSummary(recipe: RecipeView): string {
  const names = recipe.processes.map((entry) => entry.name)
  const shown = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ")
  const checks = [recipe.checks.quick, recipe.checks.full].filter(Boolean).length
  return [shown || "No processes", checks ? plural(checks, "check") : ""].filter(Boolean).join(" · ")
}

/* ------------------------------------------------------------------ */
/* One project                                                         */
/* ------------------------------------------------------------------ */

function ProjectApp({ root, onBack }: { root: string; onBack: () => void }) {
  const [setup, setSetup] = useState<ProjectAppSetup | null>(null)
  const [failure, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const error = threadAppDriver()?.setup ? failure : "This Mako can't run apps."
  const read = useCallback(() => {
    const driver = threadAppDriver()
    if (!driver?.setup) return
    void driver.setup(root).then(
      (next) => { setSetup(next); setError(null) },
      (reason) => setError(reason instanceof Error ? reason.message : String(reason)),
    )
  }, [root])
  useEffect(() => {
    read()
    const again = () => { if (document.visibilityState === "visible") read() }
    window.addEventListener("focus", again)
    return () => window.removeEventListener("focus", again)
  }, [read])

  const allow = async (next: boolean) => {
    const driver = threadAppDriver()
    if (!driver?.allowSecrets || !setup?.secrets) return
    setSaving(true)
    setSetup({ ...setup, secrets: { ...setup.secrets, allowed: next } })
    try {
      setSetup(await driver.allowSecrets(root, next))
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason))
      read()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-7">
      <div>
        <Action size="xs" className="-ml-1.5 mb-3 text-faint" onClick={onBack}>
          <ChevronLeftIcon />
          All projects
        </Action>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-title font-semibold text-foreground">{setup?.project ?? "\u00a0"}</h3>
            <p className="mt-0.5 truncate text-label text-faint">{setup ? shortPath(setup.root) : "\u00a0"}</p>
          </div>
          {setup?.recipe.kind === "ready" ? (
            <Action tone="outline" data-app-setup-action="change" onClick={() => void changeWithAgent(setup)}>
              Change with an agent
            </Action>
          ) : null}
        </div>
      </div>

      {error ? <p className="text-ui text-negative">The project&apos;s app couldn&apos;t be read: {error}</p> : null}
      {!setup && !error ? <p className="text-ui text-faint"><Shimmer text="Reading the recipe…" /></p> : null}
      {setup?.recipe.kind === "none" ? <NotSetUp setup={setup} /> : null}
      {setup?.recipe.kind === "invalid" ? <Broken setup={setup} message={setup.recipe.message} file={setup.recipe.file} /> : null}
      {setup?.recipe.kind === "ready" ? (
        <Recipe setup={setup} state={setup.recipe} saving={saving} onAllow={(next) => void allow(next)} />
      ) : null}
    </div>
  )
}

function NotSetUp({ setup }: { setup: ProjectAppSetup }) {
  const agent = useSetupAgent()
  const hidden = useThreadApp((state) => state.hidden.includes(setup.root))
  const underWay = useThreadApp((state) =>
    Object.values(state.byCwd).find((view) => view.kind === "setting-up" && view.root === setup.root)
  )
  return (
    <div className="rounded-lg bg-shell/55 [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
      <Blank
        title={underWay?.kind === "setting-up" ? `“${underWay.thread.title}” is setting it up` : `${setup.project} isn’t set up to run yet`}
        body={
          underWay
            ? "Every Thread of the project gets the app once its recipe is saved and its checks pass."
            : "An agent works out how it installs, starts and gets checked. That’s done once; then every Thread can run its own copy."
        }
        action={
          underWay ? null : (
            <div className="mt-3 flex flex-col items-center gap-2">
              <Action
                tone="solid"
                size="md"
                data-app-setup-action="set-up"
                disabled={!agent}
                onClick={() => {
                  close()
                  void startProjectSetup(setup.root, setup.project)
                }}
              >
                Set up in a new Thread
              </Action>
              <span className="text-label text-faint">{agent ? setupAgentLabel(agent) : "Sign in to an agent in Settings first"}</span>
              {hidden ? (
                <Action size="xs" className="mt-1 text-faint" onClick={() => showSetupFor(setup.root)}>
                  Show Run app in its Threads again
                </Action>
              ) : null}
            </div>
          )
        }
      />
    </div>
  )
}

function Broken({ setup, message, file }: { setup: ProjectAppSetup; message: string; file?: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg bg-negative/[0.06] px-4 py-3.5 [box-shadow:inset_0_0_0_0.5px_color-mix(in_oklab,var(--negative)_30%,transparent)]">
        <p className="text-ui font-medium text-negative">The recipe is broken, so its Threads can’t run the app</p>
        <p className="mt-1 text-label leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{message}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Action tone="outline" data-app-setup-action="repair" onClick={() => void newThreadWith(setup.root, environmentRepairPrompt(message))}>
          Fix it in a new Thread
        </Action>
        <Action tone="ghost" onClick={() => void actions.copy(environmentRepairPrompt(message))}>
          Copy to paste elsewhere
        </Action>
        {file ? (
          <Action tone="ghost" onClick={() => void desktop.revealPath(file)}>
            Show the file
          </Action>
        ) : null}
      </div>
    </div>
  )
}

type ReadyRecipe = Extract<ProjectAppSetup["recipe"], { kind: "ready" }>

function Recipe({ setup, state, saving, onAllow }: { setup: ProjectAppSetup; state: ReadyRecipe; saving: boolean; onAllow: (allow: boolean) => void }) {
  const { recipe } = state
  const checks = (["quick", "full"] as const).flatMap((tier) => (recipe.checks[tier] ? [{ tier, command: recipe.checks[tier] }] : []))
  const values = Object.entries(recipe.values)
  return (
    <>
      <Part title="Runs">
        {recipe.processes.length ? (
          recipe.processes.map((process) => (
            <Line key={process.name} name={process.name} aside={portLabel(process.port)}>
              <Command>{process.command}</Command>
              {process.cwd ? <span className="text-faint"> in {process.cwd}</span> : null}
            </Line>
          ))
        ) : (
          <Line name="Nothing to start" muted>The recipe runs checks only.</Line>
        )}
        {recipe.oneAtATime ? (
          <Line name="One copy at a time" muted>
            Its port or data can’t be split, so only one Thread runs it at once; the others ask before taking a turn.
          </Line>
        ) : null}
      </Part>

      {checks.length ? (
        <Part title="Checks">
          {checks.map(({ tier, command: steps }) => (
            <Line key={tier} name={tier === "quick" ? "Quick check" : "Full check"} aside={steps.length > 1 ? plural(steps.length, "step") : undefined}>
              {steps.length === 1 && !steps[0]!.name ? (
                <Command>{steps[0]!.command}</Command>
              ) : (
                <ol className="flex flex-col gap-1">
                  {steps.map((step) => (
                    <li key={step.name} className="flex items-baseline gap-2">
                      <span className="shrink-0 text-foreground">{step.name}</span>
                      <Command className="min-w-0">{step.command}</Command>
                      {step.parallel ? <span className="shrink-0 text-faint">at the same time as its neighbors</span> : null}
                    </li>
                  ))}
                </ol>
              )}
            </Line>
          ))}
        </Part>
      ) : null}

      {recipe.prepare.length ? (
        <Part title="Before it starts">
          {recipe.prepare.map((step) => (
            <Line key={step.command} name={<Command className="text-foreground">{step.command}</Command>}>
              {step.link
                ? `A new Thread’s ${list(step.outputs.map(atAnyDepth))} link to the main folder’s packages, so it starts without installing while ${list(step.inputs)} ${step.inputs.length === 1 ? "is" : "are"} the same there. Before anything installs in a Thread, it gets its own copy.`
                : <>Runs once in each Thread’s checkout, and again after a change to {list(step.inputs, "or")}.{step.outputs.length ? ` A new Thread starts with ${list(step.outputs.map(atAnyDepth))} cloned from the main folder while ${list(step.inputs)} ${step.inputs.length === 1 ? "is" : "are"} the same there.` : ""}</>}
            </Line>
          ))}
        </Part>
      ) : null}

      {setup.secrets ? <Credentials setup={setup} secrets={setup.secrets} saving={saving} onAllow={onAllow} /> : null}

      {recipe.carry.length ? (
        <Part title="New Threads also get" hint="Files Git ignores, copied from the main folder as they are.">
          <ListCardRow className="flex flex-wrap gap-1.5">
            {recipe.carry.map((entry) => <FileName key={entry}>{entry}</FileName>)}
          </ListCardRow>
        </Part>
      ) : null}

      {values.length ? (
        <Part title="Values" hint="Set in every process’s and agent’s environment, for each Thread.">
          {values.map(([name, value]) => (
            <ListCardRow key={name} className="flex items-baseline gap-4 py-2.5 first:pt-3 last:pb-3">
              <span className="w-44 shrink-0 truncate font-mono text-label text-foreground">{name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-label text-muted-foreground">{value}</span>
            </ListCardRow>
          ))}
        </Part>
      ) : null}

      {state.versions.length > 1 ? <Versions versions={state.versions} /> : null}

      <RecipeSource state={state} />
    </>
  )
}

/** What an agent could go back to: read-only, since going back is a new version proved like any other. */
function Versions({ versions }: { versions: RecipeVersionView[] }) {
  return (
    <Part title="Versions" hint="An agent can bring an earlier one back; Mako proves it again before every Thread gets it.">
      {versions.map((entry) => <VersionRow key={entry.version} entry={entry} />)}
    </Part>
  )
}

function VersionRow({ entry }: { entry: RecipeVersionView }) {
  const credit = [entry.by ? `By ${entry.by}` : undefined, entry.state === "draft" && entry.parent !== undefined ? `made from version ${entry.parent}` : undefined]
    .filter(Boolean)
    .join(", ")
  return (
    <ListCardRow>
      <div className="flex items-baseline gap-3">
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-ui font-medium text-foreground">Version {entry.version}</span>
          {entry.current ? <Chip>Every Thread runs it</Chip> : entry.state === "draft" ? <Chip>This folder’s draft</Chip> : null}
        </span>
        <span className="shrink-0 text-label text-faint tabular-nums">
          {entry.state === "draft" ? `Saved ${ago(entry.savedAt)}` : `Published ${ago(entry.publishedAt ?? entry.savedAt)}`}
        </span>
      </div>
      {entry.reason ? <p className="mt-1 text-label leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{entry.reason}</p> : null}
      <p className="mt-0.5 text-label text-faint [overflow-wrap:anywhere]">
        {credit ? `${credit} · ` : null}
        <VersionProof entry={entry} />
      </p>
    </ListCardRow>
  )
}

function VersionProof({ entry }: { entry: RecipeVersionView }) {
  if (!entry.readable) return <span className="text-caution">This Mako can’t read its recipe</span>
  if (!entry.proof) return <>{entry.state === "draft" ? "Not proved yet" : "Never proved"}</>
  if (!entry.proof.passed) return <span className="text-caution">Its last proof failed at {entry.proof.failed}</span>
  return <>{entry.state === "draft" ? "Passed its proof, not published" : "Proved"}</>
}

function Credentials({ setup, secrets, saving, onAllow }: {
  setup: ProjectAppSetup
  secrets: NonNullable<ProjectAppSetup["secrets"]>
  saving: boolean
  onAllow: (allow: boolean) => void
}) {
  const shown = secrets.files.length ? secrets.files : secrets.patterns
  return (
    <Part title="Credentials">
      <ListCardRow className="flex items-center gap-8">
        <div className="min-w-0 flex-1">
          <div className="text-ui font-medium">Copy into each new Thread</div>
          <p className="mt-0.5 max-w-[34rem] text-label leading-relaxed text-muted-foreground">
            {secrets.allowed
              ? `Mako copies these from ${setup.project}’s main folder into each Thread’s own checkout${secrets.allowedAt ? `; allowed ${ago(secrets.allowedAt)}` : ""}. Agents never open them.`
              : `Threads in their own checkout start without these until you allow it. Mako copies them from ${setup.project}’s main folder; agents never open them.`}
          </p>
        </div>
        <Toggle label="Copy credentials into each new Thread" on={secrets.allowed} disabled={saving} onChange={() => onAllow(!secrets.allowed)} />
      </ListCardRow>
      <ListCardRow className="flex flex-wrap items-center gap-1.5">
        {shown.map((entry) => <FileName key={entry}>{entry}</FileName>)}
        {secrets.files.length ? null : (
          <span className="text-label text-faint">Nothing in the main folder matches yet.</span>
        )}
      </ListCardRow>
    </Part>
  )
}

function RecipeSource({ state }: { state: ReadyRecipe }) {
  const where =
    state.draft
      ? `Version ${state.version ?? ""}, a draft saved${state.savedAt ? ` ${ago(state.savedAt)}` : ""} that only this folder's app runs until an agent proves and publishes it.`
      : state.source === "mako"
      ? `${state.version ? `Version ${state.version}, saved` : "Saved"} in Mako${state.savedAt ? ` ${ago(state.savedAt)}` : ""}, for every branch${state.earlier ? `; ${plural(state.earlier, "earlier version")} kept` : ""}.`
      : "Committed with the project as .mako/recipe.json, so it changes with the branch."
  return (
    <div className="flex items-center gap-3 border-t border-hairline pt-4">
      <p className="min-w-0 flex-1 text-label leading-relaxed text-faint">
        {where}
        {state.ignored ? " A committed .mako/recipe.json is ignored while this one exists." : ""}
      </p>
      <Action size="xs" className="text-muted-foreground" onClick={() => void desktop.revealPath(state.file)}>
        Show the file
      </Action>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Part({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <Eyebrow>{title}</Eyebrow>
        {hint ? <span className="min-w-0 truncate text-label text-faint">{hint}</span> : null}
      </div>
      <ListCard>{children}</ListCard>
    </section>
  )
}

function Line({ name, aside, muted, children }: { name: ReactNode; aside?: string; muted?: boolean; children?: ReactNode }) {
  return (
    <ListCardRow>
      <div className="flex items-baseline gap-3">
        <span className={cn("min-w-0 flex-1 truncate text-ui font-medium", muted ? "text-muted-foreground" : "text-foreground")}>{name}</span>
        {aside ? <span className="shrink-0 text-label text-faint tabular-nums">{aside}</span> : null}
      </div>
      {children ? <div className="mt-1 text-label leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{children}</div> : null}
    </ListCardRow>
  )
}

function Command({ className, children }: { className?: string; children: ReactNode }) {
  return <code className={cn("font-mono text-label text-muted-foreground", className)}>{children}</code>
}

function FileName({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center rounded-md bg-raised px-2 font-mono text-label text-foreground/85 [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
      {children}
    </span>
  )
}

/** `{port}` is the Thread's own first port; a plain number is the same for every Thread. */
function portLabel(port: string | undefined): string | undefined {
  if (!port) return undefined
  const own = /^\{\s*port\s*(?:\+\s*(\d+))?\s*\}$/.exec(port)
  if (own) return own[1] ? `Thread port + ${own[1]}` : "Thread port"
  return /^\d+$/.test(port) ? `Port ${port}, fixed` : port
}

/** `**\/node_modules` reads as the folder it names. */
function atAnyDepth(pattern: string): string {
  return pattern.replace(/^\*\*\//, "")
}

function list(entries: string[], joiner = "and"): string {
  if (entries.length <= 1) return entries.join("")
  return `${entries.slice(0, -1).join(", ")} ${joiner} ${entries.at(-1)}`
}

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${plural(hours, "hour")} ago`
  return `${plural(Math.round(hours / 24), "day")} ago`
}
