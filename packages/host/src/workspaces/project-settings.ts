import { readFile, realpath, stat } from "node:fs/promises"
import { z } from "zod"
import { JsonObjectSchema, JsonValueSchema, jsonStoreAccess, unknownFields, type JsonObject } from "@mako/sessions/store-format"
import type { Git } from "@mako/git"
import { publishFile } from "../base/published-files.js"
import type { MethodTable } from "../base/methods.js"
import { githubRepositoryUrl } from "../contracts/cloud-threads.js"
import { githubOwnerName, ProjectSettingsChangeSchema, type ProjectSettingsChange, type ProjectSettingsView } from "../contracts/project-settings.js"
import type { WorktreeStartPoint } from "../contracts/thread-worktrees.js"

/** The file's format: a build that knows a later one reads and rewrites this one too (`jsonStoreAccess`). */
const FORMAT = 1
const PROJECT_FIELDS = ["baseBranch"] as const
const FileSchema = z.object({ projects: JsonObjectSchema })
const ProjectSchema = z.object({ baseBranch: z.string().min(1).max(255).optional() })

type Raw = { projects: JsonObject; rest: JsonObject; access: ReturnType<typeof jsonStoreAccess> }

/**
 * What the person set for each project in Settings › Projects, by repository (its top folder, real path): one JSON
 * file in the user root, so the installed app, `dev` and every profile start a project's Threads the same way. It keeps
 * `version`; a build that can't write the format leaves it alone, and a rewrite keeps the projects and fields it
 * doesn't name. Read again only when the file's time moves, since `WorktreeStarts.point` asks on every summaries pass.
 */
export class ProjectSettingsStore {
  readonly #file: string
  #held: { stamp: string; raw: Raw } | undefined
  #writing: Promise<unknown> = Promise.resolve()

  constructor(file: string) {
    this.#file = file
  }

  /** The branch new Threads in this repository start from, as the person chose it. */
  async baseBranch(repoRoot: string): Promise<string | undefined> {
    const entry = ProjectSchema.safeParse((await this.#raw()).projects[repoRoot])
    return entry.success ? entry.data.baseBranch : undefined
  }

  /** Sets the repository's settings to `change`; null clears one. One write at a time, each over the file as it is then. */
  save(repoRoot: string, change: ProjectSettingsChange): Promise<void> {
    const run = this.#writing.then(async () => {
      const raw = await this.#raw()
      if (raw.access !== "write") throw new Error("A newer Mako keeps these settings; update Mako to change them here.")
      const current = raw.projects[repoRoot]
      const next: JsonObject = { ...unknownFields(current, PROJECT_FIELDS) }
      if (change.baseBranch !== null) next.baseBranch = change.baseBranch
      const projects: JsonObject = { ...raw.projects }
      if (Object.keys(next).length) projects[repoRoot] = next
      else delete projects[repoRoot]
      await publishFile(this.#file, `${JSON.stringify({ ...raw.rest, version: FORMAT, projects }, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      this.#held = undefined
    })
    this.#writing = run.catch(() => {})
    return run
  }

  async #raw(): Promise<Raw> {
    const empty: Raw = { projects: {}, rest: {}, access: "write" }
    const info = await stat(this.#file).catch(() => undefined)
    if (!info) return empty
    const stamp = `${info.mtimeMs}:${info.size}`
    if (this.#held?.stamp === stamp) return this.#held.raw
    let parsed: z.infer<typeof JsonValueSchema>
    try {
      parsed = JsonValueSchema.parse(JSON.parse(await readFile(this.#file, "utf8")))
    } catch {
      // A torn or hand-broken file: nothing is chosen until it reads again, and a save writes it whole.
      return empty
    }
    const access = jsonStoreAccess(parsed, FORMAT)
    const file = FileSchema.safeParse(parsed)
    const raw: Raw = file.success ? { projects: file.data.projects, rest: unknownFields(parsed, ["version", "projects"]), access } : { ...empty, access }
    this.#held = { stamp, raw }
    return raw
  }
}

/** The folder's repository's top folder, real path; empty for a folder that isn't in one. */
async function repositoryOf(git: Git, folder: string): Promise<string> {
  const source = await realpath(folder).catch(() => "")
  if (!source) return ""
  return git.output(source, ["rev-parse", "--show-toplevel"]).catch(() => "")
}

export interface ProjectSettingsDeps {
  git: Git
  store: ProjectSettingsStore
  /** Where a new Thread of the repository would start now, by Mako's own rule (no chosen branch). */
  automatic(repoRoot: string): Promise<WorktreeStartPoint | null>
  /** Whether `ref` names a commit in the repository. */
  resolves(repoRoot: string, ref: string): Promise<boolean>
}

/** One project's settings as Settings › Projects shows them. */
export async function projectSettingsView(deps: ProjectSettingsDeps, folder: string): Promise<ProjectSettingsView> {
  const repository = await repositoryOf(deps.git, folder)
  const remote = await deps.git.output(repository || folder, ["remote", "get-url", "origin"]).catch(() => "")
  const url = remote ? githubRepositoryUrl(remote) : undefined
  const cloud = url ? githubOwnerName(url) : null
  if (!repository) return { folder, repository: null, baseBranch: null, automatic: null, missing: false, cloud }
  const [baseBranch, automatic] = await Promise.all([
    deps.store.baseBranch(repository),
    deps.automatic(repository).catch(() => null),
  ])
  const missing = baseBranch ? !(await deps.resolves(repository, baseBranch)) : false
  return { folder, repository, baseBranch: baseBranch ?? null, automatic: automatic?.from ?? null, missing, cloud }
}

/** Saves `change` for `folder`'s repository, refusing a folder that isn't one and a branch it doesn't have. */
export async function saveProjectSettings(deps: ProjectSettingsDeps, folder: string, change: ProjectSettingsChange): Promise<ProjectSettingsView> {
  const parsed = ProjectSettingsChangeSchema.parse(change)
  const repository = await repositoryOf(deps.git, folder)
  if (!repository) throw new Error("This folder isn't one Git repository, so each of its repositories starts from its own branch.")
  if (parsed.baseBranch !== null && !(await deps.resolves(repository, parsed.baseBranch)))
    throw new Error(`${parsed.baseBranch} isn't a branch of this repository.`)
  await deps.store.save(repository, parsed)
  return projectSettingsView(deps, folder)
}

/** Settings › Projects: one project's settings, read and saved. */
export function declareProjectSettingsMethods(methods: MethodTable, deps: ProjectSettingsDeps | null): void {
  const unavailable = () => new Error("This Mako keeps no project settings.")
  methods.handle("mako:project-settings", (folder: string): Promise<ProjectSettingsView> => {
    if (!deps) throw unavailable()
    return projectSettingsView(deps, folder)
  })
  methods.handle("mako:project-settings-save", (folder: string, change: ProjectSettingsChange): Promise<ProjectSettingsView> => {
    if (!deps) throw unavailable()
    return saveProjectSettings(deps, folder, change)
  })
}
