import { execFileSync } from "node:child_process"

// Imported first by every script that makes scratch repositories. Run by
// `git bisect run` or a Git hook, a script inherits GIT_DIR and its kin, and
// each `git` it starts then works on that repository whatever its cwd: the
// fixture's `git init` reinitializes it and `git config` writes into it.
for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).split("\n"))
  if (name) delete process.env[name]
