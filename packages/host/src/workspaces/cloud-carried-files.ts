import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import type { Git } from "@mako/git"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { MethodTable } from "../base/methods.js"
import type { CarriedFilesDecision, CarriedFilesSync, CarriedFilesView, CarriedFileView, CloudCarriedFile } from "../contracts/cloud-carried-files.js"
import { projectRoot, type ProjectRecipeRead } from "./thread-recipe.js"
import { holdsCredentials, matchedEntries } from "./worktree-carry.js"

/**
 * A project's carried files kept in Mako Cloud (secrets.md, "One secret system"): the files its recipe's `carry`
 * names, read from its main checkout, as a new worktree here gets them. The recipe is the only list; nothing else
 * says what goes. They leave this Mac only once its person said so for the project, asked once, and then go up as a
 * Thread of the project moves to the cloud or starts there, each file only when it changed since this Mac last sent
 * it, by its content's hash. A file the person removes from the cloud stays here until they copy it again; one the
 * recipe stops carrying, or the main checkout no longer has, is removed from the cloud at the next sync.
 *
 * This Mac keeps, per account and project, the person's word, the files they kept here, and for each file sent its
 * hash and the version the cloud gave it, never a value. The cloud keeps no hash: a file the cloud lists under
 * another version than the one this Mac got back (another Mac sent it, or it was removed) is sent again.
 */

/** The cloud's limit on one file, and on how many one project keeps. */
export const CARRIED_FILE_MAX_BYTES = 256 * 1024
export const CARRIED_FILES_MAX = 40

/** A file that holds variables by `NAME=value` lines: env files and their kin, whose names (never values) are read. */
const VARIABLE_FILES = /^(\.env(\..+)?|\.dev\.vars(\..+)?|\.envrc)$/
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]{0,63})\s*=/

/** The variables an env-shaped file defines, by name: what a recipe's named secrets are checked against in the cloud. */
export function variableNames(path: string, bytes: Buffer): string[] {
  if (!VARIABLE_FILES.test(basename(path))) return []
  const names = new Set<string>()
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    const name = ASSIGNMENT.exec(line)?.[1]
    if (name) names.add(name)
    if (names.size >= 200) break
  }
  return [...names].sort()
}

const ProjectStateSchema = z.object({
  decision: z.enum(["allowed", "declined"]),
  decidedAt: z.number(),
  /** Files the person removed from the cloud, kept on this Mac until they copy them again. */
  kept: z.array(z.string()).default([]),
  /** Each file this Mac sent: its content's hash, and the version the cloud gave it. */
  sent: z.record(z.string(), z.object({ sha256: z.string(), version: z.string() })).default({}),
})
type ProjectState = z.infer<typeof ProjectStateSchema>
const StateSchema = z.object({ accounts: z.record(z.string(), z.record(z.string(), ProjectStateSchema)).default({}) })
type State = z.infer<typeof StateSchema>

/** The account's store, as this Mac's device reaches it (`CloudAccount.carriedFiles`). */
export interface CarriedFilesStore {
  list(repository: string): Promise<CloudCarriedFile[]>
  put(repository: string, file: { path: string; data: Buffer; names: string[] }): Promise<CloudCarriedFile>
  remove(repository: string, path?: string): Promise<string[]>
}

export type CloudCarriedFilesOptions = {
  /** `<data root>/cloud/carried-files.json`. */
  file: string
  git: Git
  /** The signed-in account's ID and its store, or undefined while this Mac can't reach one. */
  account(): Promise<{ id: string; store: CarriedFilesStore } | undefined>
  /** The project's GitHub repository, which the cloud knows it by; throws for a folder the cloud can't run. */
  repositoryOf(folder: string): Promise<string>
  /** The project's recipe as its Threads run it: none, one, or one that couldn't be read, which says nothing of what goes. */
  recipe(checkout: string): Promise<ProjectRecipeRead>
}

/** A file read from the main checkout, to be sent. */
type Local = { path: string; data: Buffer; sha256: string; names: string[] }

export class CloudCarriedFiles {
  readonly #options: CloudCarriedFilesOptions
  /** One change to the state file at a time, and one sync per project. */
  #writing: Promise<unknown> = Promise.resolve()
  readonly #syncing = new Map<string, Promise<CarriedFilesSync>>()

  constructor(options: CloudCarriedFilesOptions) {
    this.#options = options
  }

  /** What `folder`'s project carries to the cloud, and where each file stands there. */
  async view(folder: string): Promise<CarriedFilesView> {
    const project = await projectRoot(this.#options.git, folder)
    const repository = await this.#options.repositoryOf(project).catch(() => null)
    const { locals, staying, unreadable } = await this.#locals(project)
    const view: CarriedFilesView = { project, repository, decision: "unasked", files: [], staying }
    if (unreadable) view.problem = `This project's recipe can't be read (${unreadable}), so what it carries isn't known; nothing in Mako Cloud changes until it can be.`
    const account = await this.#options.account()
    const state = account && repository ? (await this.#read()).accounts[account.id]?.[repository] : undefined
    if (state) view.decision = state.decision
    let cloud: CloudCarriedFile[] = []
    if (account && repository && state?.decision === "allowed")
      cloud = await account.store.list(repository).catch((error: Error) => {
        view.problem = `Mako Cloud couldn't be reached: ${error.message}`
        return []
      })
    view.files = locals.map((local): CarriedFileView => {
      const there = cloud.find((file) => file.path === local.path)
      const sent = state?.sent[local.path]
      return {
        path: local.path,
        bytes: local.data.length,
        credentials: holdsCredentials(local.path),
        cloud: there ? { savedAt: there.savedAt, current: sent?.version === there.version && sent.sha256 === local.sha256 } : null,
        kept: state?.kept.includes(local.path) ?? false,
      }
    })
    return view
  }

  /**
   * The person's word for `folder`'s project. Allowed, its files go up now; declined, every file of it the cloud
   * keeps is removed. Answers the project as it stands after.
   */
  async decide(folder: string, decision: Exclude<CarriedFilesDecision, "unasked">): Promise<CarriedFilesView> {
    const { repository, account } = await this.#target(folder)
    await this.#change(account.id, repository, (state) => ({ decision, decidedAt: Date.now(), kept: state?.kept ?? [], sent: decision === "allowed" ? (state?.sent ?? {}) : {} }))
    hostLog("cloud-carried-files", "the person decided for a project", { repository, decision })
    if (decision === "allowed") await this.sync(folder, "allowed")
    else await account.store.remove(repository)
    return this.view(folder)
  }

  /** One file removed from the cloud, kept on this Mac until the person copies it again (`keep` false). */
  async keep(folder: string, path: string, keep: boolean): Promise<CarriedFilesView> {
    const { repository, account } = await this.#target(folder)
    await this.#change(account.id, repository, (state) => {
      if (!state) throw new Error("Copying this project's files to Mako Cloud isn't on.")
      const kept = keep ? [...new Set([...state.kept, path])].sort() : state.kept.filter((each) => each !== path)
      const sent = { ...state.sent }
      if (keep) delete sent[path]
      return { ...state, kept, sent }
    })
    if (keep) await account.store.remove(repository, path)
    else await this.sync(folder, "copied again")
    return this.view(folder)
  }

  /**
   * Brings the cloud's copy of `folder`'s project up to date, if its person allowed it: each file sent only when it
   * changed since this Mac sent it, or the cloud holds another version; a file the recipe no longer carries, or the
   * person kept here, removed. Nothing for a project not allowed. What a move and a cloud start wait for.
   */
  sync(folder: string, why: string): Promise<CarriedFilesSync> {
    const key = folder
    let syncing = this.#syncing.get(key)
    if (!syncing) {
      syncing = this.#sync(folder, why).finally(() => this.#syncing.delete(key))
      this.#syncing.set(key, syncing)
    }
    return syncing
  }

  async #sync(folder: string, why: string): Promise<CarriedFilesSync> {
    const began = performance.now()
    const none: CarriedFilesSync = { sent: [], removed: [], unchanged: 0 }
    const account = await this.#options.account()
    if (!account) return none
    const project = await projectRoot(this.#options.git, folder)
    const repository = await this.#options.repositoryOf(project).catch(() => undefined)
    if (!repository) return none
    const state = (await this.#read()).accounts[account.id]?.[repository]
    if (state?.decision !== "allowed") return none
    const { locals, unreadable } = await this.#locals(project)
    // A recipe that can't be read says nothing of what goes: nothing is sent, and nothing the cloud keeps is removed.
    if (unreadable) {
      hostWarn("cloud-carried-files", "a project's recipe couldn't be read; its carried files stay as the cloud keeps them", { repository, why, unreadable })
      return none
    }
    const going = locals.filter((local) => !state.kept.includes(local.path))
    const cloud = await account.store.list(repository)
    const changed = going.filter((local) => {
      const sent = state.sent[local.path]
      return !sent || sent.sha256 !== local.sha256 || cloud.find((file) => file.path === local.path)?.version !== sent.version
    })
    const sent = await Promise.all(changed.map(async (local) => ({ local, saved: await account.store.put(repository, { path: local.path, data: local.data, names: local.names }) })))
    const stale = cloud.filter((file) => !going.some((local) => local.path === file.path)).map((file) => file.path)
    const removed = (await Promise.all(stale.map((path) => account.store.remove(repository, path)))).flat()
    await this.#change(account.id, repository, (current) => {
      const next = { ...(current ?? state), sent: { ...(current ?? state).sent } }
      for (const { local, saved } of sent) next.sent[local.path] = { sha256: local.sha256, version: saved.version }
      for (const path of Object.keys(next.sent)) if (!going.some((local) => local.path === path)) delete next.sent[path]
      return next
    })
    const result = { sent: sent.map(({ local }) => local.path), removed, unchanged: going.length - changed.length }
    hostLog("cloud-carried-files", "a project's carried files synced", { repository, why, sent: result.sent.join(",") || "none", removed: removed.join(",") || "none", unchanged: result.unchanged, ms: Math.round(performance.now() - began) })
    return result
  }

  /**
   * The files the recipe's `carry` copies, read from the main checkout; and what it carries that doesn't go, with why.
   * `unreadable`: why the recipe couldn't be read, when it couldn't, and nothing is listed: no recipe carries nothing,
   * but one that can't be read isn't known to.
   */
  async #locals(project: string): Promise<{ locals: Local[]; staying: Array<{ path: string; why: string }>; unreadable?: string }> {
    const read = await this.#options.recipe(project)
    if (read.kind === "unreadable") return { locals: [], staying: [], unreadable: read.why }
    const entries = read.kind === "recipe" ? (read.recipe.carry ?? []) : []
    const staying: Array<{ path: string; why: string }> = entries.filter((entry) => entry.link).map((entry) => ({ path: entry.path, why: "linked to the main folder, not copied" }))
    const paths: string[] = []
    for (const entry of await matchedEntries(this.#options.git, project, entries.filter((entry) => !entry.link).map((entry) => entry.path))) {
      const info = await stat(join(project, entry)).catch(() => undefined)
      if (info?.isDirectory()) paths.push(...(await filesUnder(project, entry)))
      else if (info?.isFile()) paths.push(entry)
    }
    const locals: Local[] = []
    for (const path of [...new Set(paths)].sort()) {
      const info = await stat(join(project, path)).catch(() => undefined)
      if (!info) continue
      if (info.size > CARRIED_FILE_MAX_BYTES) {
        staying.push({ path, why: `larger than ${CARRIED_FILE_MAX_BYTES / 1024} KiB` })
        continue
      }
      if (locals.length >= CARRIED_FILES_MAX) {
        staying.push({ path, why: `past the ${CARRIED_FILES_MAX} files a project keeps in the cloud` })
        continue
      }
      const data = await readFile(join(project, path))
      locals.push({ path, data, sha256: createHash("sha256").update(data).digest("hex"), names: variableNames(path, data) })
    }
    return { locals, staying }
  }

  async #target(folder: string): Promise<{ repository: string; account: { id: string; store: CarriedFilesStore } }> {
    const account = await this.#options.account()
    if (!account) throw new Error("Sign in to Mako Cloud to keep this project's files there.")
    const repository = await this.#options.repositoryOf(await projectRoot(this.#options.git, folder))
    return { repository, account }
  }

  async #read(): Promise<State> {
    const text = await readFile(this.#options.file, "utf8").catch(() => "{}")
    try {
      return StateSchema.parse(JSON.parse(text))
    } catch (error) {
      hostWarn("cloud-carried-files", "the carried files' state couldn't be read; starting from none", { error: error instanceof Error ? error.message : String(error) })
      return { accounts: {} }
    }
  }

  /** One project's state changed and written whole, one change at a time. */
  #change(accountId: string, repository: string, change: (state: ProjectState | undefined) => ProjectState): Promise<void> {
    const work = this.#writing.then(async () => {
      const state = await this.#read()
      const projects = state.accounts[accountId] ?? {}
      projects[repository] = ProjectStateSchema.parse(change(projects[repository]))
      state.accounts[accountId] = projects
      await mkdir(dirname(this.#options.file), { recursive: true })
      const temporary = `${this.#options.file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      await rename(temporary, this.#options.file)
    })
    this.#writing = work.catch(() => undefined)
    return work
  }
}

/** Every file under a carried folder, by its path in the checkout; links are left where they are. */
async function filesUnder(project: string, folder: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (inner: string) => {
    for (const entry of await readdir(join(project, inner), { withFileTypes: true }).catch(() => [])) {
      const path = `${inner}/${entry.name}`
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) found.push(path)
      else if (entry.isSymbolicLink() && (await lstat(join(project, path)).then(() => stat(join(project, path))).catch(() => undefined))?.isFile()) found.push(path)
      if (found.length > CARRIED_FILES_MAX) return
    }
  }
  await walk(folder)
  return found
}

/** What the window asks of a project's carried files: what goes and where each stands, the person's word, a file kept here. */
export function declareCarriedFilesMethods(methods: MethodTable, carried: CloudCarriedFiles | undefined) {
  const unavailable = () => Promise.reject(new Error("This Mako can't keep a project's files in Mako Cloud."))
  methods.handle("mako:cloud-carried-files", (folder: string): Promise<CarriedFilesView> => carried?.view(folder) ?? unavailable())
  methods.handle("mako:cloud-carried-files-decide", (folder: string, allowed: boolean): Promise<CarriedFilesView> => carried?.decide(folder, allowed ? "allowed" : "declined") ?? unavailable())
  methods.handle("mako:cloud-carried-files-keep", (folder: string, path: string, keep: boolean): Promise<CarriedFilesView> => carried?.keep(folder, path, keep) ?? unavailable())
}
