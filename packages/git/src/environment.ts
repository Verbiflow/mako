/**
 * The variables by which a Git process (a hook, `git bisect run`) tells the
 * processes it starts which repository to work on: `git rev-parse
 * --local-env-vars` without the per-invocation config. Inherited, they send
 * every `git` to that repository whatever its cwd, so `git init` in another
 * folder reinitializes it and `git config` writes into it.
 */
export const REPOSITORY_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_GRAFT_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_PREFIX",
] as const

/** Mako picks each repository by cwd; one it was started inside is no default. */
export function forgetStartingRepository(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of REPOSITORY_VARIABLES) delete env[name]
}
