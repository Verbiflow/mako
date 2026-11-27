import { execFileSync } from "node:child_process"

// Imported first by every script that makes scratch repositories. Run by
// `git bisect run` or a Git hook, a script inherits GIT_DIR and its kin, and
// each `git` it starts then works on that repository whatever its cwd: the
// fixture's `git init` reinitializes it and `git config` writes into it.
for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).split("\n"))
  if (name) delete process.env[name]

// A fetch or commit ends by starting Git's maintenance in the background, and the Git on CI's Linux runners (2.56)
// repacks a repository of a few small packs there, writing into objects/pack after the command has returned. A script
// removing its scratch repositories as it ends met that write: test-move-merge passed, then its cleanup failed with
// ENOTEMPTY on mac/.git/objects/pack (gate, 2026-11-22). A repository that lives for one script needs no maintenance.
process.env.GIT_CONFIG_PARAMETERS = "'maintenance.auto'='false' 'gc.auto'='0'"
