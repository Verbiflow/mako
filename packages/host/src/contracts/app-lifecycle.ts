import { z } from "zod"

/** How many uncommitted files a reading or a build names; the rest are counted. */
export const UNCOMMITTED_LISTED = 200

/** A file with changes Git hasn't committed, as `git status` sees it. */
export const UncommittedFileSchema = z.object({
  path: z.string(),
  change: z.enum(["edited", "added", "deleted", "renamed", "untracked", "conflicted"]),
  /** A renamed file's earlier path. */
  from: z.string().optional(),
})
export type UncommittedFile = z.infer<typeof UncommittedFileSchema>

/**
 * A checkout's uncommitted work, tracked changes and untracked files alike:
 * how many files, and the first `UNCOMMITTED_LISTED` of them by name. A
 * local build takes the checkout as it is, so this is what it carries beyond
 * its revision.
 */
export const UncommittedChangesSchema = z.object({
  count: z.number().int().nonnegative(),
  files: z.array(UncommittedFileSchema),
})
export type UncommittedChanges = z.infer<typeof UncommittedChangesSchema>

export const BuildIdentitySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{12,64}$/),
  builtAt: z.iso.datetime(),
  revision: z
    .string()
    .regex(/^[a-f0-9]{7,40}$/)
    .nullable(),
  dirty: z.boolean(),
  /**
   * The uncommitted files the build took from its checkout, as the updater
   * read them before building. Absent from a clean build, and from one
   * packaged by an updater that didn't pass them (`dirty` says only that).
   */
  uncommitted: UncommittedChangesSchema.optional(),
})
export type BuildIdentity = z.infer<typeof BuildIdentitySchema>
export const LifecycleWorkSchema = z.object({
  id: z.string(),
  token: z.string(),
  title: z.string(),
  provider: z.string(),
  cwd: z.string(),
  status: z.enum(["running", "waiting", "queued", "finishing"]),
  stoppable: z.boolean(),
})
export type LifecycleWork = z.infer<typeof LifecycleWorkSchema>
export const LifecycleActionSchema = z.enum(["quit", "install", "restart"])
export type LifecycleAction = z.infer<typeof LifecycleActionSchema>
export const LifecycleStateSchema = z.object({
  work: z.array(LifecycleWorkSchema),
  revision: z.string(),
  operation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("idle") }),
    z.object({ kind: z.literal("waiting"), action: LifecycleActionSchema }),
    z.object({ kind: z.literal("stopping"), action: LifecycleActionSchema }),
    z.object({ kind: z.literal("applying"), action: LifecycleActionSchema }),
    z.object({
      kind: z.literal("error"),
      action: LifecycleActionSchema,
      message: z.string(),
    }),
  ]),
})
export type LifecycleState = z.infer<typeof LifecycleStateSchema>
export const LifecycleCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancel") }),
  z.object({ kind: z.literal("wait"), action: LifecycleActionSchema }),
  z.object({
    kind: z.literal("stop"),
    action: LifecycleActionSchema,
    revision: z.string(),
  }),
])
export type LifecycleCommand = z.infer<typeof LifecycleCommandSchema>
/**
 * The commits one revision has that another doesn't, along first parents: on
 * a branch that takes pull requests by merge or squash, one per pull request.
 */
export interface RevisionChanges {
  /** The revision counted from; null when it isn't in the checkout. */
  from: string | null
  count: number
  /** The newest commits' subjects, newest first, at most `CHANGE_TITLES`. */
  titles: string[]
}
/** How many commit subjects a `RevisionChanges` keeps. */
export const CHANGE_TITLES = 8

/**
 * What Build does with the source checkout as it stands. Only a checkout on
 * the branch that tracks the upstream, behind it, without changes to tracked
 * files, is brought forward first; anything else is built as it is, and
 * `why` says what kept it from the upstream.
 */
export type UpdateSourcePlan =
  /** The build would carry the installed revision and nothing newer can reach the checkout. */
  | { kind: "current" }
  /** Fast-forward the branch that tracks the upstream to the upstream's commit, then build that. */
  | { kind: "fast-forward" }
  | {
      kind: "as-is"
      why:
        /** On the branch that tracks the upstream, at its commit. */
        | "level"
        /** On that branch with commits the upstream doesn't have, and none it has. */
        | "ahead"
        /** Behind, but tracked files have uncommitted changes. */
        | "changes"
        /** Both have commits the other doesn't. */
        | "diverged"
        /** On a branch other than the one that tracks the upstream. */
        | "branch"
        /** HEAD isn't on a branch. */
        | "detached"
        /** No remote with a default branch to compare with. */
        | "no-upstream"
      /** The commit it would build is the installed one, without changes: there is nothing to build. */
      installed: boolean
    }

/** The source checkout against the upstream updates come from, as Mako last read it. */
export type UpdateSource =
  | { kind: "unreadable"; reason: string }
  | {
      kind: "checkout"
      /** The commit checked out. */
      head: string
      /** Null when HEAD is detached. */
      branch: string | null
      /**
       * The remote's default branch (`origin/main`) and its commit as last
       * fetched, and the local branch that tracks it, if one does.
       */
      upstream: { name: string; commit: string; branch: string | null } | null
      /** Commits HEAD has that the upstream doesn't, and the other way round. */
      ahead: number
      behind: number
      /** Tracked files with uncommitted changes. */
      changed: number
      /** Files Git doesn't track or ignore; a build copies them too. */
      untracked: number
      /** Those files by name, from the same reading: what a build of the checkout as it is takes beyond `head`. */
      uncommitted: UncommittedChanges
      /** Whether this reading fetched the upstream first; a failure says why, and the reading uses what was fetched before. */
      fetch: { kind: "fetched" } | { kind: "skipped" } | { kind: "failed"; reason: string }
      plan: UpdateSourcePlan
      /** The revision Build would build: the upstream's commit for a fast-forward, HEAD otherwise. */
      target: string
      /** What `target` has that the installed build doesn't; null without an installed revision. */
      changes: RevisionChanges | null
      readAt: string
    }

/** Packages the source checkout's package-lock.json lists that its node_modules doesn't hold: how many, and the first few by name. */
export interface MissingDependencies {
  count: number
  names: string[]
}

export type LocalBuildState =
  | { kind: "idle" }
  | {
      kind: "building"
      /** `installing` runs npm install in the source checkout first, only when its node_modules is behind its package-lock.json. */
      phase: "installing" | "copying" | "compiling" | "checking" | "packaging" | "verifying"
      /** The commit being built, once the checkout has been read and brought forward. */
      revision?: string
      /** What the install brings, while `phase` is `installing`. */
      dependencies?: MissingDependencies
    }
  | {
      kind: "ready"
      build: BuildIdentity
      /** What the build has that the installed one doesn't. */
      changes: RevisionChanges | null
      /** The branch fast-forwarded before building, and to which commit. */
      forwarded: { branch: string; from: string; to: string } | null
    }
  | {
      kind: "error"
      message: string
      /** A command that fixes it, run by hand in a terminal: `cd '<checkout>' && npm install`. */
      command?: string
    }
export interface UpdateInstallation {
  distribution: "development" | "local" | "signed" | "unsigned"
  build: BuildIdentity | null
  source: string | null
  local: LocalBuildState
  /** The source checkout against its upstream; null until read, and without a source. */
  checkout: UpdateSource | null
  /** A reading of the source, with a fetch, is under way. */
  reading: boolean
  /** What the running build brought over the one it replaced, when it was installed from Settings. */
  installed: RevisionChanges | null
}
