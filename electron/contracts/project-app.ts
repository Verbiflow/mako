/**
 * A project's app setup as Settings shows it: the recipe every Thread runs
 * its app from, written out.
 */

export interface RecipeProcessView {
  name: string
  command: string
  /** As the recipe writes it, such as `{port+1}`, or a fixed number. */
  port?: string
  cwd?: string
}

/** One step of a check; a check of one command is one step without a name. */
export interface RecipeCheckStepView {
  name?: string
  command: string
  /** Runs at the same time as the steps beside it that say so too. */
  parallel?: boolean
}

export interface RecipeView {
  values: Record<string, string>
  processes: RecipeProcessView[]
  checks: { quick?: RecipeCheckStepView[]; full?: RecipeCheckStepView[] }
  prepare: { command: string; inputs: string[]; outputs: string[]; link: boolean }[]
  /** Files Git ignores that new Threads get from the main checkout; `credentials` for one named like an env or key file. */
  carry: { path: string; link: boolean; credentials: boolean }[]
  oneAtATime: boolean
}

/** One of a project's recipe versions, as its history lists it. */
export interface RecipeVersionView {
  version: number
  state: "draft" | "published"
  /** The version every Thread of the project runs now. */
  current: boolean
  savedAt: number
  /** The published version a draft was made from. */
  parent?: number
  /** Who saved it, such as `the Thread "Fix login" (codex)`. */
  by?: string
  reason?: string
  publishedAt?: number
  /** How its last proof went, and the first step that didn't pass. */
  proof?: { at: number; passed: boolean; failed?: string }
  /** False for a version whose recipe this Mako can't read, such as one a newer Mako saved. */
  readable: boolean
}

export type ProjectRecipeState =
  | { kind: "none" }
  | { kind: "invalid"; message: string; file?: string }
  | {
      kind: "ready"
      /** Saved in Mako for every Thread and branch, or committed with the project. */
      source: "mako" | "committed"
      file: string
      savedAt?: number
      /** Earlier versions Mako keeps of a saved recipe. */
      earlier: number
      /** Its number among the project's versions. */
      version?: number
      /** A draft only this folder's app runs, not yet published to every Thread. */
      draft?: boolean
      /** A committed recipe that Mako's saved one replaces. */
      ignored?: string
      recipe: RecipeView
      /** The newest published versions and this folder's draft, newest first, to see what an agent could go back to. */
      versions: RecipeVersionView[]
    }

export interface ProjectAppSetup {
  project: string
  root: string
  recipe: ProjectRecipeState
}
