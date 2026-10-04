import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REPOSITORY_VARIABLES, forgetStartingRepository } from "../electron/git-environment.js"

const scripts = import.meta.dirname
const root = mkdtempSync(join(tmpdir(), "mako-git-environment-"))
const clean = { ...process.env }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

try {
  const local = git(root, "rev-parse", "--local-env-vars").split("\n").filter((name) => !name.startsWith("GIT_CONFIG"))
  assert.deepEqual([...REPOSITORY_VARIABLES].sort(), local.sort(), "the app forgets exactly the variables Git names, less per-invocation config")

  // The outer repository as `git bisect run` and hooks hand it on: a linked worktree's GIT_DIR.
  const outer = join(root, "outer")
  git(root, "init", "-q", "-b", "main", outer)
  git(outer, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "outer")
  git(outer, "worktree", "add", "-q", "--detach", join(root, "linked"))
  const outerDir = git(join(root, "linked"), "rev-parse", "--absolute-git-dir")
  const config = join(outer, ".git", "config")
  const before = readFileSync(config, "utf8")
  const fixture = (folder: string, preamble: string) => {
    const file = join(root, `${folder}.mjs`)
    writeFileSync(file, `${preamble}
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
const cwd = ${JSON.stringify(join(root, folder))}
mkdirSync(cwd)
execFileSync("git", ["init", "-q"], { cwd })
execFileSync("git", ["config", "user.name", "Fixture"], { cwd })
`)
    execFileSync(process.execPath, [file], { env: { ...clean, GIT_DIR: outerDir, GIT_PREFIX: "" } })
  }

  fixture("unguarded", "")
  assert.match(readFileSync(config, "utf8"), /bare = true[\s\S]*name = Fixture/, "without the guard, the fixture rewrites the outer repository")
  writeFileSync(config, before)

  fixture("guarded", `import ${JSON.stringify(join(scripts, "lib", "scratch-git.mjs"))}`)
  assert.equal(readFileSync(config, "utf8"), before, "the guarded fixture leaves the outer repository alone")
  assert.equal(git(join(root, "guarded"), "config", "user.name"), "Fixture")

  const env: NodeJS.ProcessEnv = { ...clean, GIT_DIR: outerDir, GIT_WORK_TREE: outer, GIT_INDEX_FILE: join(outerDir, "index") }
  forgetStartingRepository(env)
  execFileSync("git", ["init", "-q", join(root, "app")], { env })
  assert.equal(readFileSync(config, "utf8"), before, "the app's git leaves the repository it was started in alone")
  console.log("PASS: a scratch git init, under the app's environment or a test's, never reaches the repository a Git process started it in")

  const entry = readFileSync(join(scripts, "..", "electron", "entry.ts"), "utf8")
  assert.ok(entry.indexOf("forgetStartingRepository()") >= 0 && entry.indexOf("forgetStartingRepository()") < entry.indexOf("await import("), "every Mako process forgets its starting repository before loading anything")
  const unguarded = readdirSync(scripts)
    .filter((name) => /\.(ts|mjs|js)$/.test(name))
    .filter((name) => {
      const source = readFileSync(join(scripts, name), "utf8")
      const initializes = /(?<!subtype:\s*)(?<!"-q?m",\s*)"init"/.test(source)
      return initializes && !source.replace(/^#!.*\n/, "").startsWith('import "./lib/scratch-git.mjs"\n')
    })
  assert.deepEqual(unguarded, [], "scripts that run git init import ./lib/scratch-git.mjs first")
  console.log("PASS: Mako's entry and every script that makes a repository forget the outer one first")
} finally {
  rmSync(root, { recursive: true, force: true })
}
