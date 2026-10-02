/**
 * A project's app setup as Settings shows it: the recipe every Thread runs
 * its app from, written out, and the credentials files new Threads may have.
 */

export interface RecipeProcessView {
  name: string
  command: string
  /** As the recipe writes it, such as `{port+1}`, or a fixed number. */
  port?: string
  cwd?: string
}

export interface RecipeView {
  values: Record<string, string>
  processes: RecipeProcessView[]
  checks: { quick?: string; full?: string }
  prepare: { command: string; inputs: string[]; outputs: string[]; link: boolean }[]
  carry: string[]
  oneAtATime: boolean
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
      /** A committed recipe that Mako's saved one replaces. */
      ignored?: string
      recipe: RecipeView
    }

/** The files the recipe names as holding credentials, and the person's answer. */
export interface ProjectSecrets {
  patterns: string[]
  /** What they match in the main checkout now. */
  files: string[]
  allowed: boolean
  /** When the person allowed them. */
  allowedAt?: number
}

export interface ProjectAppSetup {
  project: string
  root: string
  recipe: ProjectRecipeState
  secrets?: ProjectSecrets
}
