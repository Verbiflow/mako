import { useEffect, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { ChevronLeftIcon, ChevronRightIcon, EyeIcon } from "lucide-react"
import type { ProjectSettingsView } from "@mako/host/contracts/project-settings"
import type { ProjectAppSetup, RecipeView } from "@mako/host/contracts/project-app"
import type { WorktreeBranch } from "@mako/host/contracts/thread-worktrees"
import { Action, Blank, Chip, Eyebrow, Field, ListCard, ListCardRow, SettingRow, Toggle } from "@/components/ui/kit"
import { IfCanReveal } from "@/components/ui/machine-gate"
import { SearchSelect } from "@/components/ui/search-select"
import { Shimmer } from "@/components/ui/shimmer"
import { cn } from "@/lib/utils"
import { openAppSetup } from "@/state/app-setup"
import { desktop } from "@/state/desktop"
import { prefsStore, setProjectHidden, usePrefs } from "@/state/prefs"
import {
  PROJECTS_DEFAULTS,
  projectSettingsStore,
  readProjectSettings,
  saveProjectBase,
  useProjectGroups,
  useProjectSettingsChoice,
} from "@/state/project-settings"
import { startProjectSetup, useSetupAgent } from "@/state/project-setup"
import { changeWithAgent } from "@/state/recipe-change"
import { threadAppDriver } from "@/state/thread-app"
import { readWorktreeBranches } from "@/state/worktrees"
import { localWords } from "@mako/protocol/computer-words"

const HOME = /^\/(?:Users|home)\/[^/]+(?=\/)/
const shortPath = (path: string) => path.replace(HOME, "~")
const folderName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path

export function ProjectsSection() {
  const chosen = useProjectSettingsChoice((state) => state.chosen)
  return chosen ? (
    <ProjectPage key={chosen} root={chosen} onBack={() => projectSettingsStore.set({ chosen: undefined })} />
  ) : (
    <ProjectList onOpen={(root) => projectSettingsStore.set({ chosen: root })} />
  )
}

/* ------------------------------------------------------------------ */
/* Every project                                                       */
/* ------------------------------------------------------------------ */

function ProjectList({ onOpen }: { onOpen: (root: string) => void }) {
  const { active, hidden } = useProjectGroups()
  return (
    <div className="flex flex-col gap-7">
      <p className="text-ui leading-relaxed text-muted-foreground">
        Each project’s folder, where its new Threads start, how its app installs and runs, and the GitHub repository its cloud Threads use.
      </p>
      {PROJECTS_DEFAULTS.map((Part, index) => <Part key={index} />)}
      <section className="flex flex-col gap-2" data-projects="active">
        <Eyebrow>Active</Eyebrow>
        {active.length ? (
          <ListCard className="px-0">
            {active.map((root) => <ProjectRow key={root} root={root} onOpen={() => onOpen(root)} />)}
          </ListCard>
        ) : (
          <div className="bg-raised">
            <Blank title="No projects yet" body="Start a Thread in a project folder and it shows up here." />
          </div>
        )}
      </section>
      {hidden.length ? (
        <section className="flex flex-col gap-2" data-projects="hidden">
          <div className="flex items-baseline gap-3">
            <Eyebrow>Hidden</Eyebrow>
            <span className="min-w-0 truncate text-label text-faint">Kept out of the sidebar. Working in one brings it back.</span>
          </div>
          <ListCard className="px-0">
            {hidden.map((root) => <ProjectRow key={root} root={root} hidden onOpen={() => onOpen(root)} />)}
          </ListCard>
        </section>
      ) : null}
    </div>
  )
}

function ProjectRow({ root, hidden = false, onOpen }: { root: string; hidden?: boolean; onOpen: () => void }) {
  return (
    <div className="group flex items-center transition-colors duration-100 hover:bg-fill-hover">
      <button
        type="button"
        data-project-row={folderName(root)}
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left"
      >
        <span className={cn("min-w-0 flex-1", hidden && "opacity-60")}>
          <span className="block truncate text-ui font-medium text-foreground">{folderName(root)}</span>
          <span className="mt-0.5 block truncate text-label text-faint">{shortPath(root)}</span>
        </span>
      </button>
      {hidden ? (
        <Action size="xs" className="mr-1 text-muted-foreground" data-project-show={folderName(root)} onClick={() => setProjectHidden(root, false)}>
          <EyeIcon />
          Show
        </Action>
      ) : null}
      <button type="button" tabIndex={-1} aria-hidden onClick={onOpen} className="flex self-stretch items-center pr-4 pl-2">
        <ChevronRightIcon className="size-3.5 shrink-0 text-faint transition-colors duration-100 group-hover:text-muted-foreground" />
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* One project                                                         */
/* ------------------------------------------------------------------ */

function ProjectPage({ root, onBack }: { root: string; onBack: () => void }) {
  const hidden = usePrefs((prefs) => prefs.hiddenProjects.includes(root))
  const [settings, setSettings] = useState<ProjectSettingsView | null>(null)
  // Null: this Mako runs no project apps, so there's no recipe to read.
  const [setup, setSetup] = useState<ProjectAppSetup | null | undefined>(() => (threadAppDriver()?.setup ? undefined : null))
  useEffect(() => {
    let live = true
    void readProjectSettings(root).then((next) => live && setSettings(next), () => live && setSettings(null))
    const read = threadAppDriver()?.setup
    if (read) void read(root).then((next) => live && setSetup(next), () => live && setSetup(null))
    return () => { live = false }
  }, [root])

  return (
    <div className="flex flex-col gap-8" data-project-page={folderName(root)}>
      <div>
        <Action size="xs" className="-ml-1.5 mb-3 text-faint" onClick={onBack}>
          <ChevronLeftIcon />
          All projects
        </Action>
        <div className="flex items-center gap-2.5">
          <h3 className="min-w-0 truncate text-title font-semibold text-foreground">{folderName(root)}</h3>
          {hidden ? <Chip>Hidden</Chip> : null}
        </div>
      </div>

      <Part title="Folder">
        <ListCardRow>
          <div className="flex items-center gap-3">
            <code className="min-w-0 flex-1 truncate font-mono text-label text-foreground" title={root}>{shortPath(root)}</code>
            <IfCanReveal>
              <Action size="xs" className="text-muted-foreground" data-project-action="reveal" onClick={() => void desktop.revealPath(root)}>
                Show in Finder
              </Action>
            </IfCanReveal>
            <Action size="xs" className="text-muted-foreground" data-project-action="copy-path" onClick={() => void navigator.clipboard.writeText(root).then(() => toast("Path copied"))}>
              Copy path
            </Action>
            <Action size="xs" className="text-muted-foreground" onClick={() => void desktop.openInEditor(root, prefsStore.get().externalEditor)}>
              Open in editor
            </Action>
          </div>
          <p className="mt-1 text-label text-faint">Mako names the project after its folder.</p>
        </ListCardRow>
        <ListCardRow className="py-0 first:pt-0 last:pb-0">
          <SettingRow title="Show in the sidebar" description="A hidden project is listed under Hidden at the end of the sidebar, and comes back once you work in it.">
            <Toggle label="Show in the sidebar" on={!hidden} onChange={() => setProjectHidden(root, !hidden)} />
          </SettingRow>
        </ListCardRow>
      </Part>

      <StartsFrom root={root} settings={settings} onSaved={setSettings} />
      <Scripts root={root} setup={setup} />
      <Environment root={root} setup={setup} />
      <Cloud settings={settings} />
    </div>
  )
}

/** Where a new Thread's worktree branch starts: Mako's own rule, or a branch the person chose. */
function StartsFrom({ root, settings, onSaved }: { root: string; settings: ProjectSettingsView | null; onSaved: (next: ProjectSettingsView) => void }) {
  const [branches, setBranches] = useState<WorktreeBranch[]>([])
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    void readWorktreeBranches(root).then(setBranches, () => setBranches([]))
  }, [root])
  const choose = (next: string) => {
    const baseBranch = next === "" ? null : next
    if (baseBranch === (settings?.baseBranch ?? null)) return
    setSaving(true)
    void saveProjectBase(root, baseBranch).then(onSaved, (error: Error) => toast("The branch wasn't saved", { description: error.message })).finally(() => setSaving(false))
  }
  const automatic = settings?.automatic
  return (
    <Part title="New Threads">
      <ListCardRow className="py-0 first:pt-0 last:pb-0">
        {!settings ? (
          <SettingRow title="Start from" description="Reading the repository…" />
        ) : !settings.repository ? (
          <SettingRow title="Start from" description="This folder holds several repositories, so a Thread’s worktree starts each one from that repository’s own branch." />
        ) : (
          <SettingRow
            title="Start from"
            warning={settings.missing && settings.baseBranch ? `${settings.baseBranch} isn’t in the repository now, so new Threads start from ${automatic ?? "the folder’s branch"} until it is.` : undefined}
            description="The branch each new Thread’s worktree branches from. Automatic is the folder’s branch, or its upstream when that has newer commits."
          >
            <div data-project-base={settings.baseBranch ?? ""}>
              <SearchSelect
                value={settings.baseBranch ?? ""}
                label="Start new Threads from"
                searchPlaceholder="Search branches"
                className="w-56"
                disabled={saving}
                allowCustom
                customDetail="Start from this branch"
                options={[
                  { value: "", label: "Automatic", detail: automatic ? `${automatic} now` : undefined },
                  ...branches.filter((branch) => branch.name !== settings.baseBranch).map((branch) => ({ value: branch.name, label: branch.name, detail: branch.remote ? "Remote branch" : undefined })),
                  ...settings.baseBranch ? [{ value: settings.baseBranch, label: settings.baseBranch }] : [],
                ]}
                onChange={choose}
              />
            </div>
          </SettingRow>
        )}
      </ListCardRow>
    </Part>
  )
}

type ReadyRecipe = Extract<ProjectAppSetup["recipe"], { kind: "ready" }>

/**
 * The recipe's setup and run commands, each editable in place. A recipe changes only through an agent, which makes
 * the change and has Mako prove it before every Thread gets it, so an edit here becomes that request in a new Thread
 * with the recipe attached, for the person to send.
 */
function Scripts({ root, setup }: { root: string; setup: ProjectAppSetup | null | undefined }) {
  const agent = useSetupAgent()
  const fullRecipe = (
    <Action size="xs" className="text-muted-foreground" data-project-action="recipe" onClick={() => openAppSetup(root, "recipe")}>
      Checks and versions in Apps
    </Action>
  )
  if (setup === undefined)
    return <Part title="Scripts"><ListCardRow><Shimmer className="text-ui text-faint" text="Reading the recipe…" /></ListCardRow></Part>
  if (setup === null)
    return <Part title="Scripts"><ListCardRow><p className="text-label text-faint">This Mako doesn’t run project apps, so the project has no setup or run scripts here.</p></ListCardRow></Part>
  if (setup.recipe.kind === "none")
    return (
      <Part title="Scripts">
        <ListCardRow>
          <div className="flex items-center gap-4">
            <p className="min-w-0 flex-1 text-label leading-relaxed text-muted-foreground">
              Not set up yet. An agent works out how the project installs, starts and gets checked, once, and every Thread then runs its own copy.
            </p>
            <Action tone="outline" disabled={!agent} data-project-action="set-up" onClick={() => {
              window.dispatchEvent(new CustomEvent("mako:close-settings"))
              void startProjectSetup(setup.root, setup.project)
            }}>
              Set up in a new Thread
            </Action>
          </div>
        </ListCardRow>
      </Part>
    )
  if (setup.recipe.kind === "invalid")
    return (
      <Part title="Scripts" action={fullRecipe}>
        <ListCardRow>
          <p className="text-ui font-medium text-negative">The recipe is broken, so its Threads can’t run the app</p>
          <p className="mt-1 text-label leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{setup.recipe.message}</p>
        </ListCardRow>
      </Part>
    )
  const ready = setup.recipe
  const { recipe } = ready
  return (
    <Part title="Scripts" hint="Each Thread runs these in its own checkout." action={fullRecipe}>
      {recipe.prepare.map((step, index) => (
        <Script key={`setup:${step.command}`} id={`setup-${index}`} name="Setup" note={`Again after a change to ${list(step.inputs, "or")}`} command={step.command} setup={setup} ready={ready} />
      ))}
      {recipe.processes.map((process) => (
        <Script key={`run:${process.name}`} id={`run-${process.name}`} name={recipe.processes.length > 1 ? `Run · ${process.name}` : "Run"} note={process.cwd ? `In ${process.cwd}` : undefined} command={process.command} setup={setup} ready={ready} />
      ))}
      {!recipe.prepare.length && !recipe.processes.length ? (
        <ListCardRow><p className="text-label text-faint">The recipe installs nothing and starts nothing; it runs checks only.</p></ListCardRow>
      ) : null}
    </Part>
  )
}

function Script({ id, name, note, command, setup, ready }: { id: string; name: string; note?: string; command: string; setup: ProjectAppSetup; ready: ReadyRecipe }) {
  const [draft, setDraft] = useState(command)
  const changed = draft.trim() !== "" && draft.trim() !== command
  const propose = () => {
    void changeWithAgent(setup, `In the recipe, change the ${name.toLowerCase()} command from \`${command}\` to \`${draft.trim()}\`.${ready.source === "committed" ? " It's committed with the project as .mako/recipe.json." : ""}`)
  }
  return (
    <ListCardRow>
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">{name}</span>
        {note ? <span className="shrink-0 truncate text-label text-faint">{note}</span> : null}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Field
          aria-label={`${name} command`}
          data-project-script={id}
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && changed) propose()
            if (event.key === "Escape" && draft !== command) {
              event.stopPropagation()
              setDraft(command)
            }
          }}
          className="flex-1 font-mono text-label"
        />
        {changed ? (
          <>
            <Action size="sm" tone="ghost" onClick={() => setDraft(command)}>Undo</Action>
            <Action size="sm" tone="outline" data-project-action={`propose-${id}`} onClick={propose}>Change in a new Thread</Action>
          </>
        ) : null}
      </div>
    </ListCardRow>
  )
}

/** What each Thread's processes and agents get besides the code: the recipe's values, and the files it carries. */
function Environment({ root, setup }: { root: string; setup: ProjectAppSetup | null | undefined }) {
  const recipe: RecipeView | undefined = setup?.recipe.kind === "ready" ? setup.recipe.recipe : undefined
  if (!recipe) return null
  const values = Object.entries(recipe.values)
  const copied = recipe.carry.filter((entry) => !entry.link)
  const linked = recipe.carry.filter((entry) => entry.link)
  return (
    <Part
      title="Environment"
      action={(
        <Action size="xs" className="text-muted-foreground" data-project-action="setup" onClick={() => openAppSetup(root, "setup")}>
          What each place has
        </Action>
      )}
    >
      <ListCardRow>
        <p className="text-ui font-medium text-foreground">Variables</p>
        {values.length ? (
          <div className="mt-2 flex flex-col gap-1">
            {values.map(([key, value]) => (
              <div key={key} className="flex items-baseline gap-4">
                <span className="w-44 shrink-0 truncate font-mono text-label text-foreground">{key}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-label text-muted-foreground">{value}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-label text-faint">The recipe sets none.</p>
        )}
      </ListCardRow>
      <ListCardRow>
        <p className="text-ui font-medium text-foreground">Files new worktrees get</p>
        {recipe.carry.length ? (
          <div className="mt-2 flex flex-col gap-1.5 text-label text-muted-foreground">
            {copied.length ? <FileLine label="Copied" paths={copied.map((entry) => entry.path)} /> : null}
            {linked.length ? <FileLine label="Linked to the main folder" paths={linked.map((entry) => entry.path)} /> : null}
          </div>
        ) : (
          <p className="mt-1 text-label text-faint">Only what Git tracks.</p>
        )}
      </ListCardRow>
      <ListCardRow>
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-label leading-relaxed text-faint">An agent changes these, and Mako proves the recipe again before every Thread gets it.</p>
          {setup?.recipe.kind === "ready" ? (
            <Action size="xs" className="shrink-0 text-muted-foreground" onClick={() => void changeWithAgent(setup)}>
              Change with an agent
            </Action>
          ) : null}
        </div>
      </ListCardRow>
    </Part>
  )
}

function FileLine({ label, paths }: { label: string; paths: string[] }) {
  return (
    <div className="flex items-baseline gap-4">
      <span className="w-44 shrink-0 truncate">{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
        {paths.map((path) => (
          <span key={path} className="inline-flex h-6 items-center bg-raised px-2 font-mono text-label text-foreground/85">{path}</span>
        ))}
      </span>
    </div>
  )
}

/** The GitHub repository the project's cloud Threads and automations run against: its `origin`. */
function Cloud({ settings }: { settings: ProjectSettingsView | null }) {
  if (!settings) return null
  const cloud = settings.cloud
  return (
    <Part title="Cloud">
      <ListCardRow>
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block text-ui font-medium text-foreground">GitHub repository</span>
            <span className="mt-0.5 block text-label leading-relaxed text-muted-foreground">
              {cloud ? "Cloud Threads and automations of this project clone it. Mako reads it from the folder’s origin." : localWords("The folder’s origin isn’t on GitHub, so its Threads run on this Mac only.")}
            </span>
          </span>
          {cloud ? (
            <Action size="sm" tone="ghost" className="font-mono text-label" data-project-cloud={cloud} onClick={() => void desktop.openUrl(`https://github.com/${cloud}`)}>
              {cloud}
            </Action>
          ) : null}
        </div>
      </ListCardRow>
    </Part>
  )
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Part({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2" data-project-part={title}>
      <div className="flex min-h-6 items-center gap-3">
        <Eyebrow>{title}</Eyebrow>
        {hint ? <span className="min-w-0 truncate text-label text-faint">{hint}</span> : null}
        <span className="flex-1" />
        {action}
      </div>
      <ListCard>{children}</ListCard>
    </section>
  )
}

function list(entries: string[], joiner = "and"): string {
  if (entries.length <= 1) return entries.join("")
  return `${entries.slice(0, -1).join(", ")} ${joiner} ${entries.at(-1)}`
}
