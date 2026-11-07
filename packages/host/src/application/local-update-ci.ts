import { z } from "zod"

/** The workflow that runs on every commit to the default branch, and its job that runs an update's own checks. */
const CHECKS_WORKFLOW = "checks.yml"
const UPDATE_CHECKS_JOB = "update-checks"

const Repository = z.object({ default_branch: z.string() })
const Runs = z.object({
  total_count: z.number(),
  workflow_runs: z.array(z.object({
    id: z.number(),
    run_number: z.number(),
    run_attempt: z.number(),
    head_sha: z.string(),
    head_branch: z.string().nullable(),
    event: z.string(),
    status: z.string().nullable(),
    conclusion: z.string().nullable(),
    html_url: z.string(),
  })),
})
const Jobs = z.object({
  total_count: z.number(),
  jobs: z.array(z.object({ name: z.string(), run_attempt: z.number(), status: z.string(), conclusion: z.string().nullable() })),
})

/** Whether CI vouches for a commit: the run that did, or why it doesn't. */
export type CiReading = { passed: true; run: string } | { passed: false; why: string }

/** Asks GitHub for `path`, answering its JSON. */
export type GitHubApi = (path: string) => Promise<string>

/** `owner/repo` of a GitHub remote's URL; null for any other remote, which runs every check. */
export function githubRepository(url: string): string | null {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? null
}

/**
 * Whether `commit` passed CI on the repository's default branch, as GitHub
 * says it is now: a local `origin/HEAD` can be stale. The newest run of that
 * commit's push there decides, in its latest attempt, however an older run
 * went: complete, successful, with every job that runs an update's own checks
 * complete and successful. Anything else is no answer, and an update with no
 * answer runs every check: a run still going, a reading that disagrees with
 * itself, a list cut short, a pull request's run, a skipped job, no `gh`, no
 * network.
 */
export async function readCi(api: GitHubApi, repository: string, branch: string, commit: string): Promise<CiReading> {
  try {
    const { default_branch: defaultBranch } = Repository.parse(JSON.parse(await api(`repos/${repository}`)))
    if (defaultBranch !== branch) return { passed: false, why: `${repository}'s default branch is ${defaultBranch}, not ${branch}` }
    const runs = Runs.parse(JSON.parse(await api(`repos/${repository}/actions/workflows/${CHECKS_WORKFLOW}/runs?head_sha=${commit}&event=push&per_page=100`)))
    if (runs.total_count !== runs.workflow_runs.length) return { passed: false, why: "more runs of this commit than one page" }
    const run = runs.workflow_runs
      .filter((each) => each.head_sha === commit && each.head_branch === branch && each.event === "push")
      .sort((left, right) => right.run_number - left.run_number)[0]
    if (!run) return { passed: false, why: `no run of ${commit.slice(0, 12)} on ${branch}` }
    if (run.status !== "completed" || run.conclusion !== "success") return { passed: false, why: `its newest run is ${run.status}, ${run.conclusion ?? "no conclusion"}` }
    const jobs = Jobs.parse(JSON.parse(await api(`repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)))
    if (jobs.total_count !== jobs.jobs.length) return { passed: false, why: "more jobs in that run than one page" }
    const named = jobs.jobs.filter((job) => job.name === UPDATE_CHECKS_JOB)
    if (!named.length || !named.every((job) => job.run_attempt === run.run_attempt && job.status === "completed" && job.conclusion === "success")) return { passed: false, why: `${UPDATE_CHECKS_JOB} didn't pass in that run` }
    return { passed: true, run: run.html_url }
  } catch (error) {
    return { passed: false, why: error instanceof Error ? error.message : String(error) }
  }
}
