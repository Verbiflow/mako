import { z } from "zod"

/** The workflow that runs on every commit to the default branch, and its job that runs an update's own checks. */
const CHECKS_WORKFLOW = "checks.yml"
const UPDATE_CHECKS_JOB = "update-checks"

const Runs = z.object({
  workflow_runs: z.array(z.object({
    id: z.number(),
    head_sha: z.string(),
    head_branch: z.string().nullable(),
    event: z.string(),
    conclusion: z.string().nullable(),
    html_url: z.string(),
  })),
})
const Jobs = z.object({ jobs: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })) })

/** Whether CI vouches for a commit: the run that did, or why it doesn't. */
export type CiReading = { passed: true; run: string } | { passed: false; why: string }

/** Asks GitHub for `path`, answering its JSON. */
export type GitHubApi = (path: string) => Promise<string>

/** `owner/repo` of a GitHub remote's URL; null for any other remote. */
export function githubRepository(url: string): string | null {
  return /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? null
}

/**
 * Whether `commit` passed CI on `branch` itself: its push there, that exact
 * commit, a run that succeeded whole, with the job that runs an update's own
 * checks among what succeeded. Anything else is no answer, and an update with
 * no answer runs every check: a run still going, a run of a pull request, a
 * skipped job, no `gh`, no network.
 */
export async function readCi(api: GitHubApi, repository: string, branch: string, commit: string): Promise<CiReading> {
  try {
    const runs = Runs.parse(JSON.parse(await api(`repos/${repository}/actions/workflows/${CHECKS_WORKFLOW}/runs?head_sha=${commit}&event=push&per_page=20`)))
    const run = runs.workflow_runs.find((each) => each.head_sha === commit && each.head_branch === branch && each.event === "push" && each.conclusion === "success")
    if (!run) return { passed: false, why: `no green run of ${commit.slice(0, 12)} on ${branch}` }
    const jobs = Jobs.parse(JSON.parse(await api(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`)))
    if (jobs.jobs.find((job) => job.name === UPDATE_CHECKS_JOB)?.conclusion !== "success") return { passed: false, why: `${UPDATE_CHECKS_JOB} didn't pass in that run` }
    return { passed: true, run: run.html_url }
  } catch (error) {
    return { passed: false, why: error instanceof Error ? error.message : String(error) }
  }
}
