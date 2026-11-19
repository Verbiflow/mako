import type { AutomationTemplate } from "../contracts/automations.js"

/**
 * The starting points the editor offers. Each is off until the person turns it on, and every field can be changed
 * before it's saved: these are drafts, not defaults Mako runs.
 */
export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    key: "weekly-dependency-updates",
    name: "Weekly dependency updates",
    summary: "Mondays at 06:00: update dependencies within their ranges, run the checks, and open a pull request.",
    definition: {
      id: "weekly-dependency-updates",
      name: "Weekly dependency updates",
      prompt: {
        objective: "Update this project's dependencies to the newest versions their declared ranges allow, and the lockfile with them. Read each changelog for anything that changes behaviour the project relies on.",
        doneWhen: ["The lockfile is updated and installs cleanly.", "The project's typecheck, lint and tests pass.", "A pull request is open with every updated package and its version change listed."],
        boundaries: ["Don't change a declared range or move a major version.", "Don't change application code except where an update requires it; say why when it does."],
        output: "The pull request's link, the packages it moved, and anything a reviewer should look at.",
      },
      start: { access: "full", place: "here", workspace: { branch: "dependencies/{date}" } },
      triggers: [{ kind: "schedule", cron: "0 6 * * 1", timezone: "UTC" }],
      limits: { overlap: "skip", timeoutMin: 90, maxRunsPerDay: 1 },
      result: "pull-request",
    },
  },
  {
    key: "nightly-test-and-fix",
    name: "Nightly test and fix",
    summary: "Each night: run the test suite on the main branch and fix what fails, as a pull request.",
    definition: {
      id: "nightly-test-and-fix",
      name: "Nightly test and fix",
      prompt: {
        objective: "Run this project's full test suite on the newest main branch. For each failure, find its cause and fix it at the cause.",
        doneWhen: ["Every test that failed passes, or is explained as broken outside this project.", "A pull request is open with the fixes, one commit per cause."],
        boundaries: ["Don't skip, delete or loosen a test to make it pass.", "When everything passes, change nothing and say so."],
        output: "What failed and why, and the pull request's link, or that everything passed.",
      },
      start: { access: "full", place: "here", workspace: { branch: "nightly-fixes/{date}" } },
      triggers: [{ kind: "schedule", cron: "0 3 * * *", timezone: "UTC" }],
      limits: { overlap: "skip", timeoutMin: 120, maxRunsPerDay: 1 },
      result: "pull-request",
    },
  },
  {
    key: "triage-new-issues",
    name: "Triage new issues",
    summary: "Every morning: read issues opened since yesterday, label them, and report what needs a person.",
    definition: {
      id: "triage-new-issues",
      name: "Triage new issues",
      prompt: {
        objective: "Read the issues opened in this repository in the last 24 hours with `gh issue list`. For each, find what it's about in the code, label it, and say whether it's a bug, a request or a question.",
        doneWhen: ["Every new issue is labelled.", "Each likely bug names the code it's in."],
        boundaries: ["Don't close, assign or comment on an issue.", "Don't change code."],
        output: "A list: each issue, its label, where in the code, and which need a person first.",
      },
      start: { access: "auto", place: "here" },
      triggers: [{ kind: "schedule", cron: "0 8 * * 1-5", timezone: "UTC" }],
      limits: { overlap: "skip", timeoutMin: 30, maxRunsPerDay: 1 },
      result: "report",
    },
  },
  {
    key: "harness-version-bump",
    name: "Harness version bump",
    summary: "Daily: when a harness ships a release, move Mako to it and open a pull request.",
    definition: {
      id: "harness-version-bump",
      name: "Harness version bump",
      prompt: {
        objective: "A harness Mako runs published a newer release (the gate's readings say which). Move each harness's tested version to it with `npx tsx scripts/bump-harness-versions.ts <harness> --write`, place what the release changed, and open one pull request.",
        doneWhen: ["Each bumped harness's checks pass, or what fails is explained in the pull request.", "One pull request is open on the run's branch."],
        boundaries: ["Only the harnesses the gate names.", "Don't merge."],
        output: "The pull request's link and each harness's version change.",
      },
      start: { harness: "claude", access: "full", place: "here", workspace: { branch: "harness-versions/{date}" } },
      triggers: [{ kind: "schedule", cron: "17 6 * * *", timezone: "UTC" }],
      gate: { command: "npx tsx scripts/bump-harness-versions.ts --json --gate", timeoutS: 120 },
      limits: { overlap: "skip", timeoutMin: 180, maxRunsPerDay: 1 },
      result: "pull-request",
    },
  },
  {
    key: "review-pull-requests",
    name: "PR review on open",
    summary: "Each hour, when open pull requests have no review yet: review each and leave the review as a comment. GitHub's own pull request event replaces the hourly check with the cloud slice.",
    definition: {
      id: "review-pull-requests",
      name: "PR review on open",
      prompt: {
        objective: "Review the open pull requests nobody has reviewed yet (the gate's `pulls` lists them). Read each one's diff for correctness bugs, risky changes and missing tests, and post the review with `gh pr review --comment`.",
        doneWhen: ["Every pull request the gate listed has one review comment from this run."],
        boundaries: ["Don't approve, request changes, push or merge.", "Don't review a pull request this automation already commented on."],
        output: "Each pull request reviewed and its most important finding.",
      },
      start: { access: "auto", place: "here" },
      triggers: [{ kind: "schedule", cron: "5 * * * *", timezone: "UTC" }],
      gate: { command: "gh pr list --state open --search 'review:none -is:draft' --json number,title,url --jq 'if length == 0 then (\"\" | halt_error(1)) else {key: (map(.number | tostring) | join(\",\")), pulls: .} end'", timeoutS: 60 },
      limits: { overlap: "skip", timeoutMin: 30 },
      result: "report",
    },
  },
]
