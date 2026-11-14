import { execFileSync } from "node:child_process"

/**
 * When CI fails on main, says so where it can't be missed and makes the revert ready: the commit (and the pull request
 * that landed it), each job that failed with the suites or gate parts that failed in it and a link to its log, in one
 * issue per commit labelled `main-red`; and a `revert/<sha>` branch holding the commit's revert, with its pull request
 * opened when the repository lets Actions open one and a link to open it otherwise. The rule on main is fix or revert
 * within the hour, never a failure left standing: the issue says by when.
 *
 *   node scripts/ci-main-watch.mjs <run id>              what main-watch.yml runs (GH_TOKEN, GITHUB_REPOSITORY)
 *   node scripts/ci-main-watch.mjs <run id> --dry-run    prints the issue, writes nothing
 */
const [runId, mode] = process.argv.slice(2)
if (!runId) throw new Error("Use: node scripts/ci-main-watch.mjs <run id> [--dry-run]")
const dry = mode === "--dry-run"
const repo = process.env.GITHUB_REPOSITORY ?? "Verbiflow/mako"
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
const api = (path) => JSON.parse(gh("api", path))
/** The verdict jobs only gather the others: their failure says nothing of its own. */
const VERDICTS = new Set(["ci", "pr-gate"])

const run = api(`repos/${repo}/actions/runs/${runId}`)
const sha = run.head_sha
const short = sha.slice(0, 9)
const commit = api(`repos/${repo}/commits/${sha}`)
const title = commit.commit.message.split("\n")[0]
const pulls = (() => {
  try {
    return api(`repos/${repo}/commits/${sha}/pulls`).map((pull) => `#${pull.number}`)
  } catch {
    return []
  }
})()
const jobs = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repo}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`)).flatMap((page) => page.jobs)
const failed = jobs.filter((job) => job.conclusion === "failure" && !VERDICTS.has(job.name))

/** The suites or gate parts a job's log names as failed (`ci-gate.mjs`, `ci-suites.mjs`), else its failed step. */
function failures(job) {
  let log = ""
  try {
    log = gh("api", `repos/${repo}/actions/jobs/${job.id}/logs`)
  } catch {
    // A log GitHub no longer holds says nothing more than the job's failed step.
  }
  const named = [...new Set([...log.matchAll(/^\S+ (?:FAILED|BUILD FAILED|HUNG): (.+?)(?: in \d+ s)?$/gm)].map((match) => match[1]))]
  const step = job.steps?.find((each) => each.conclusion === "failure")?.name
  return named.length ? named : [step ? `step: ${step}` : "the job failed before any step"]
}

const lines = failed.map((job) => `- **${job.name}**: [log](${job.html_url})\n${failures(job).map((each) => `  - \`${each}\``).join("\n")}`)
const by = new Date(new Date(run.updated_at).getTime() + 60 * 60_000).toISOString().replace(/:\d\d\.\d+Z$/, " UTC").replace("T", " ")
const body = [
  `CI failed on main at ${sha} (${pulls.length ? `landed by ${pulls.join(", ")}` : "pushed directly"}): ${title}`,
  "",
  `Run: ${run.html_url}`,
  "",
  ...(lines.length ? lines : ["- No job failed of its own; only a verdict did. Open the run."]),
  "",
  `Fix it on main or revert it by ${by}. The revert is ready on \`revert/${short}\`.`,
].join("\n")

if (dry) {
  console.log(body)
  process.exit(0)
}

// One issue a commit: a rerun that fails again comments on it.
gh("label", "create", "main-red", "--repo", repo, "--color", "B60205", "--description", "CI failed on main: fix or revert within the hour", "--force")
const open = JSON.parse(gh("issue", "list", "--repo", repo, "--label", "main-red", "--state", "open", "--search", short, "--json", "number,title"))
const existing = open.find((issue) => issue.title.includes(short))
let issue
if (existing) {
  gh("issue", "comment", String(existing.number), "--repo", repo, "--body", body)
  issue = existing.number
} else {
  const url = gh("issue", "create", "--repo", repo, "--label", "main-red", "--title", `main is red at ${short}: ${failed.map((job) => job.name).join(", ") || "ci"}`, "--body", body).trim()
  issue = Number(url.split("/").at(-1))
}

// The revert, ready: a branch with it, and its pull request where Actions may open one. The commit is written as
// the workflow's env names its author and committer (GIT_AUTHOR_*, GIT_COMMITTER_*), and says it's the watch's own,
// so a rerun replaces only its own branch, never commits a person pushed there.
const branch = `revert/${short}`
const own = `Main-watch: revert of ${sha}`
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim()
let revert
try {
  git("fetch", "--quiet", "origin", "main")
  const existing = git("ls-remote", "--heads", "origin", branch).split(/\s+/)[0]
  let ours = true
  if (existing) {
    git("fetch", "--quiet", "origin", branch)
    ours = git("log", "-1", "--format=%B", existing).includes(own) && git("rev-list", "--count", `origin/main..${existing}`) === "1"
  }
  if (!ours) revert = `\`${branch}\` already holds commits that aren't the watch's; it was left as it is`
  else {
    git("checkout", "--quiet", "-B", branch, "origin/main")
    git("revert", "--no-commit", sha)
    git("commit", "--quiet", "-m", `Revert ${short}: ${title}`, "-m", `${sha} turned main red (#${issue}).`, "-m", own)
    git("push", "--quiet", "--force", "origin", branch)
    try {
      revert = gh("pr", "create", "--repo", repo, "--draft", "--base", "main", "--head", branch, "--title", `Revert ${short}: ${title}`, "--body", [
        `Reverts ${sha}, which turned main red (#${issue}). Merge it, or close it once a fix lands.`,
        "",
        "This pull request was opened with the workflow's token, which starts no CI. Close and reopen it to run its checks.",
      ].join("\n")).trim()
    } catch {
      revert = `https://github.com/${repo}/compare/main...${branch}?expand=1 (Actions may not open pull requests here: open it from this link)`
    }
  }
} catch (error) {
  revert = `no revert branch: ${error instanceof Error ? error.message.split("\n")[0] : String(error)} (a later commit may touch the same lines)`
}
gh("issue", "comment", String(issue), "--repo", repo, "--body", `Revert: ${revert}`)
console.log(`main-watch: #${issue} for ${short}; revert: ${revert}`)
