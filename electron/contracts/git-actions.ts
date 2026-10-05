import type { CheckSummary, GitHubStatus, PullRequest } from "./git-workspace-search.js"

/*
 * Git actions that a person takes with a button, an agent takes with a `mako`
 * tool, and a Mako slash command asks the agent to take. Their rules and their
 * words live here once, read by the window and the host alike, so the three
 * ways in can't drift apart.
 */

export function summarizeChecks(checks: readonly CheckSummary[]) {
  let passed = 0
  let failed = 0
  let running = 0
  for (const check of checks) {
    if (check.state === "passed") passed += 1
    else if (check.state === "failed") failed += 1
    else if (check.state === "running") running += 1
  }
  return { total: checks.length, passed, failed, running }
}

/** Why GitHub won't merge the pull request now, or undefined when it will. */
export function pullMergeReason(pull: Pick<PullRequest, "state" | "mergeable" | "checks" | "reviewDecision">): string | undefined {
  const checks = summarizeChecks(pull.checks)
  if (pull.state !== "open") return `This pull request is already ${pull.state}`
  if (pull.mergeable === "conflicting") return "Resolve merge conflicts first"
  if (checks.failed > 0) return "Fix failing checks first"
  if (checks.running > 0) return "Wait for checks to finish"
  if (pull.reviewDecision === "changes") return "Address requested changes first"
  return undefined
}

/** Why a pull request can't be opened from here, or null once GitHub is set up. */
export function pullSetupReason(status: GitHubStatus): string | null {
  if (!status.installed) return "Install the GitHub CLI to open a pull request."
  if (!status.authenticated) return "Sign in to GitHub with gh auth login to open a pull request."
  if (!status.repo) return "Add a GitHub remote to open a pull request."
  return null
}

/**
 * The base a branch's pull request targets unless someone picks another: the
 * branch its worktree started from when the remote has it (`origin/main` and
 * `main` both give `main`), otherwise the repository's default. Never the
 * branch itself.
 */
export function pullBaseFor(branch: string, startedFrom: string | null | undefined, remoteBranches: readonly string[], defaultBranch: string | undefined): string | undefined {
  const started = startedFrom?.replace(/^origin\//, "")
  if (started && started !== branch && remoteBranches.includes(started)) return started
  return defaultBranch === branch ? undefined : defaultBranch
}

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const
export type MergeMethod = (typeof MERGE_METHODS)[number]

/** How a pull request's title and body are written, by the drafter in the form and by an agent alike. */
export const PULL_REQUEST_WRITING = `The title is one concise imperative line with no prefix and no trailing period.

When the repository has a pull request template, the body fills in its sections. Otherwise the body is:

## Summary
- Two or three bullets explaining what changed and why

## Test plan
- A short checklist of concrete verification steps

Be specific. Do not invent tests or behavior the changes don't show.`

/** The longest pull request template passed along; the rest is cut. */
export const PULL_TEMPLATE_LIMIT = 4_000

export function clipTemplate(template: string): string {
  return template.length > PULL_TEMPLATE_LIMIT ? `${template.slice(0, PULL_TEMPLATE_LIMIT)}\n…` : template
}

/** What the form's drafter is asked, given the repository's template when it has one. */
export function pullRequestDraftPrompt(template: string | null): string {
  return [
    "Write a pull request title and body from this diff. The first line is the title; then a blank line; then the body.",
    PULL_REQUEST_WRITING,
    template ? `The repository's pull request template:\n\n${clipTemplate(template.trim())}` : "",
  ].filter(Boolean).join("\n\n")
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`

/** `a`, `a and b`, `a, b and c`, `a, b, c and 2 more files`. */
function listed(names: readonly string[], more: string): string {
  if (names.length > 3) return `${names.slice(0, 3).join(", ")} and ${plural(names.length - 3, more)}`
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("")
}

/** A message staged in the composer that asks the Thread's agent to take a Git action, with the tool it uses. */
export type GitAction =
  | { kind: "pr"; branch: string; base?: string; draft?: boolean }
  | { kind: "push"; number: number }
  | { kind: "update"; branch: string; from: string }
  | { kind: "resolve"; branch: string; from: string; files: readonly string[]; reference?: string }
  | { kind: "fix-checks"; number: number; failing: readonly string[] }
  | { kind: "review"; since: string | null }

export function gitActionPrompt(action: GitAction): string {
  switch (action.kind) {
    case "pr":
      return `Open a pull request for \`${action.branch}\`${action.base ? ` into \`${action.base}\`` : ""}${action.draft ? " as a draft" : ""}. Call pull_request_status for the base, the commits it would carry and the repository's template, and commit anything that belongs in it. Then write the title and body from what this branch does and why, and open it with pull_request_open${action.base ? ` with base \`${action.base}\`` : ""}${action.draft ? " and draft: true" : ""}. Reply with its link.`
    case "push":
      return `Bring #${action.number} up to date: commit what belongs in it, then call pull_request_open to push. If its title or body no longer says what the branch does, pass new ones.`
    case "update":
      return `Update \`${action.branch}\` from \`${action.from}\` with worktree_update. If it stops on conflicts, resolve each one keeping what both sides meant, stage the files, finish with \`git merge --continue\`, then run the checks.`
    case "resolve":
      return `Merging ${action.from} into ${action.branch} stopped on conflicts in ${listed(action.files, "more file")}.${action.reference ? ` ${action.reference} has what Git reported.` : ""} Resolve each one keeping what both sides meant, stage the files, and finish with \`git merge --continue\`.`
    case "fix-checks":
      return `${action.failing.length ? `${listed(action.failing, "more check")} ${action.failing.length === 1 ? "is" : "are"} failing` : "Checks are failing"} on #${action.number}. Call pull_request_status with logs: true to read why, fix the cause here, run the same check locally when you can, commit, and push with pull_request_open.`
    case "review":
      return action.since
        ? `Review everything on this branch since it branched from \`${action.since}\`: \`git diff ${action.since}...HEAD\`, and uncommitted changes too. Report bugs, risks and missing tests by file and line, most serious first. Don't change anything.`
        : "Review my uncommitted changes: `git diff HEAD`, and `git status` for new files. Report bugs, risks and missing tests by file and line, most serious first. Don't change anything."
  }
}

/** What the window knows about the checkout, for Mako's slash commands. */
export interface GitCommandFacts {
  /** The checked-out branch, or null when detached. */
  branch: string | null
  /** Why GitHub can't be used here, or null when it can; undefined while unknown. */
  github: string | null | undefined
  defaultBranch?: string
  /** A merge, rebase or similar in progress. */
  operation?: string | null
  /** This Thread's own worktree, when it edits in one. */
  worktree?: {
    /** The main checkout's branch, which this one lands in. */
    into: string | null
    behind: { from: string; commits: number } | null
  }
  /** The branch's open pull request. */
  pull?: { number: number; failing: readonly string[] } | null
}

export type GitCommandName = "pr" | "update" | "fix-checks" | "review"

export interface GitCommand {
  name: GitCommandName
  /** What it does here, or why it can't. */
  hint: string
  /** Set when it can't be used now. */
  blocked?: string
  /** The message it stages, when it can be used. */
  prompt?: string
}

/** Mako's Git commands for the slash menu, each with what it does here or why it can't. */
export function gitCommands(facts: GitCommandFacts): GitCommand[] {
  const { branch, worktree, pull } = facts
  const pr = ((): GitCommand => {
    if (facts.github === undefined) return { name: "pr", hint: "Open a pull request", blocked: "Checking GitHub…" }
    if (facts.github) return { name: "pr", hint: "Open a pull request", blocked: facts.github }
    if (!branch) return { name: "pr", hint: "Open a pull request", blocked: "Check out a branch first." }
    if (pull) return { name: "pr", hint: `Push new commits to #${pull.number}`, prompt: gitActionPrompt({ kind: "push", number: pull.number }) }
    if (!worktree && branch === facts.defaultBranch)
      return { name: "pr", hint: "Open a pull request", blocked: `Pull requests come from a branch other than ${branch}. Start this work on its own branch first.` }
    return { name: "pr", hint: `Open a pull request for ${branch}`, prompt: gitActionPrompt({ kind: "pr", branch }) }
  })()
  const update = ((): GitCommand => {
    const hint = `Merge ${worktree?.behind?.from ?? "main"}'s new commits into this branch`
    if (!worktree || !branch) return { name: "update", hint, blocked: "Only a Thread on its own branch updates from main." }
    if (facts.operation) return { name: "update", hint, blocked: `Finish the ${facts.operation} first.` }
    if (!worktree.behind) return { name: "update", hint, blocked: "Git couldn't tell which branch new Threads start from." }
    if (!worktree.behind.commits) return { name: "update", hint, blocked: `Already has everything in ${worktree.behind.from}.` }
    const { from, commits } = worktree.behind
    return { name: "update", hint: `${from} has ${plural(commits, "commit")} this branch doesn't`, prompt: gitActionPrompt({ kind: "update", branch, from }) }
  })()
  const fix = ((): GitCommand => {
    const hint = "Read why checks fail, fix and push"
    if (!pull) return { name: "fix-checks", hint, blocked: "Open a pull request first; its checks run on GitHub." }
    if (!pull.failing.length) return { name: "fix-checks", hint, blocked: `No checks are failing on #${pull.number}.` }
    return { name: "fix-checks", hint: `${listed(pull.failing, "more check")} failing on #${pull.number}`, prompt: gitActionPrompt({ kind: "fix-checks", number: pull.number, failing: pull.failing }) }
  })()
  const since = worktree?.into ?? null
  const review: GitCommand = {
    name: "review",
    hint: since ? `Everything since ${since}, without changing it` : "Your uncommitted changes, without changing them",
    prompt: gitActionPrompt({ kind: "review", since }),
  }
  return [pr, update, fix, review]
}
