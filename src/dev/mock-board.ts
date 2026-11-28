import { boardKey, type Board, type BoardIssue, type BoardPull, type BoardRequest } from "@mako/host/contracts/project-pulls"

/**
 * The mock bridge's pull requests and issues: every project folder holds two repositories (`acme/api`, `acme/web`)
 * and a third (`acme/infra`) this login can't read, so a list shows each section, `name#n` codes and a failed line.
 */
export function mockBoard(request: BoardRequest, now = Date.now()): Board {
  const hour = 60 * 60_000
  const pull = (repository: string, number: number, title: string, patch: Partial<BoardPull>): BoardPull => ({
    key: boardKey(repository, number), repository, number, title, url: `https://github.com/${repository}/pull/${number}`,
    author: "mako-dev", draft: false, state: "open", head: `branch-${number}`, base: "main",
    createdAt: now - 30 * hour, updatedAt: now - 2 * hour, checks: { passed: 7, failed: 0, running: 0, total: 7 },
    reviewRequested: false, mine: false, ...patch,
  })
  const issue = (repository: string, number: number, title: string, patch: Partial<BoardIssue>): BoardIssue => ({
    key: boardKey(repository, number), repository, number, title, url: `https://github.com/${repository}/issues/${number}`,
    author: "someone", state: "open", createdAt: now - 50 * hour, updatedAt: now - 5 * hour, assigned: false, labels: [], comments: 2, ...patch,
  })
  const repositories = {
    "acme/api": { name: "acme/api", url: "https://github.com/acme/api", readAt: now },
    "acme/web": { name: "acme/web", url: "https://github.com/acme/web", readAt: now },
    "acme/infra": { name: "acme/infra", url: "https://github.com/acme/infra", problem: { kind: "no-access" as const } },
  }
  return {
    kind: request.kind,
    viewer: "mako-dev",
    projects: request.folders.map((folder) => ({ folder, repositories: ["acme/api", "acme/infra", "acme/web"] })),
    repositories,
    pulls: request.kind === "pulls" ? [
      pull("acme/api", 412, "Retry webhook deliveries with backoff", { mine: true, checks: { passed: 5, failed: 2, running: 0, total: 7 }, updatedAt: now - 2 * hour }),
      pull("acme/web", 90, "Inbox keyboard model", { reviewRequested: true, author: "teammate", updatedAt: now - 20 * 60_000 }),
      pull("acme/web", 88, "Inbox redesign", { review: "approved", updatedAt: now - 26 * hour }),
      pull("acme/api", 415, "Bump harness versions", { checks: { passed: 3, failed: 0, running: 4, total: 7 }, updatedAt: now - 5 * 60_000 }),
      pull("acme/api", 77, "Move the cron to the queue", { author: "teammate", review: "changes", updatedAt: now - 3 * 24 * hour }),
      pull("acme/web", 91, "Try a denser pull request row", { draft: true, mine: true, updatedAt: now - 6 * hour }),
      pull("acme/api", 409, "Drop the legacy token path", { state: "merged", closedAt: now - 30 * hour }),
      pull("acme/web", 85, "Phone list polish", { state: "merged", closedAt: now - 50 * hour }),
      pull("acme/web", 80, "Experiment: sticky composer", { state: "closed", closedAt: now - 4 * 24 * hour }),
    ] : [],
    issues: request.kind === "issues" ? [
      issue("acme/api", 501, "Webhook retries pile up after an outage", { assigned: true, labels: ["bug"], updatedAt: now - hour }),
      issue("acme/web", 140, "Pull requests panel: show who reviews", { labels: ["design"] }),
      issue("acme/web", 133, "Dark mode contrast on faint text", { updatedAt: now - 30 * hour }),
      issue("acme/api", 498, "Rate limit headroom alarm", { state: "closed", closedAt: now - 2 * 24 * hour }),
    ] : [],
  }
}
