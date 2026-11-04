import type { GitHubAsk, GitHubAskAnswer, GitHubAskOutcome, GitHubReach } from "@mako/host/contracts/github-reach"

/**
 * A fixture's scene for GitHub reach, from its address's `github-reach=`: only the project's repository (the default),
 * a chosen set, every repository, two pending asks, an ask someone answered on another device before this one, and
 * refusals (a repository the App can't see, an ask that expired).
 */
export const GITHUB_REACH_SCENES = ["repository", "chosen", "installation", "asks", "answered", "refused"] as const
export type GitHubReachScene = (typeof GITHUB_REACH_SCENES)[number]

export function githubReachScene(asked: string | null): GitHubReachScene {
  return GITHUB_REACH_SCENES.find((scene) => scene === asked) ?? "repository"
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

/** The fixtures' cloud Threads by name, as a device that listed them would know them. Made up. */
export const GITHUB_REACH_THREADS = {
  "t-docs-search": "Wire search into the docs site",
  "t-checkout-kit": "Move checkout to the shared UI kit",
} satisfies Record<string, string>

const owner = (repository: string) => repository.replace(/^https:\/\/github\.com\//, "").split("/")[0] ?? "acme"

function sceneReach(scene: GitHubReachScene, repository: string): GitHubReach {
  const own = owner(repository)
  if (scene === "installation") return { mode: "installation" }
  if (scene === "chosen" || scene === "refused") return { mode: "chosen", repositories: [`${own}/docs`, `${own}/design-tokens`, `${own}/api-schema`] }
  return { mode: "repository" }
}

function sceneAsks(scene: GitHubReachScene, repository: string): GitHubAsk[] {
  if (scene !== "asks" && scene !== "answered" && scene !== "refused") return []
  const own = owner(repository)
  const ask = (id: string, threadId: string, repositories: string[], why: string, minutes: number): GitHubAsk => ({
    id,
    repository,
    threadId,
    repositories,
    access: "read",
    why,
    askedAt: minutesAgo(minutes),
    state: "pending",
    answeredAt: null,
  })
  return [
    ask(`ask-kit-${own}`, "t-checkout-kit", [`${own}/ui-kit`, `${own}/design-tokens`], "Checkout imports the shared components, and I need their props in v3 to update the call sites.", 3),
    ask(`ask-docs-${own}`, "t-docs-search", [`${own}/docs`], "The search index reads the docs site's front matter; I need its field names.", 42),
  ]
}

/**
 * The transport's answers for a fixture, kept per project: each change answers after a moment, as the cloud does. In
 * `refused` a repository ending `-ops` is one the App can't see and every ask has expired; in `answered` the first
 * ask answered was already allowed elsewhere.
 */
export function mockGitHubReachStore(scene: GitHubReachScene) {
  const projects = new Map<string, { reach: GitHubReach; asks: GitHubAsk[] }>()
  // The asks are the first project's, so a list of every project's shows each once.
  const project = (repository: string) => {
    let found = projects.get(repository)
    if (!found) projects.set(repository, (found = { reach: sceneReach(scene, repository), asks: projects.size ? [] : sceneAsks(scene, repository) }))
    return found
  }
  let othersAnswered = scene === "answered"
  const pause = () => new Promise((resolve) => setTimeout(resolve, 600))
  const pending = () => [...projects.values()].flatMap((each) => each.asks).filter((ask) => ask.state === "pending").sort((left, right) => right.askedAt.localeCompare(left.askedAt))
  return {
    /** Projects a fixture lists, read so their asks exist before any is shown. */
    seed: (repositories: string[]) => void repositories.forEach(project),
    read: async (repository: string) => {
      const kept = project(repository)
      return { reach: kept.reach, asks: kept.asks.filter((ask) => ask.state === "pending") }
    },
    save: async (repository: string, reach: GitHubReach): Promise<GitHubReach> => {
      await pause()
      if (scene === "refused" && reach.mode === "chosen") {
        const unseen = reach.repositories.find((name) => name.endsWith("-ops"))
        if (unseen) throw new Error(`Mako's GitHub App can't see ${unseen}. Add it to the App's installation on GitHub, or pick another.`)
      }
      project(repository).reach = reach
      return reach
    },
    asks: async () => pending(),
    answer: async (askId: string, answer: GitHubAskAnswer): Promise<GitHubAskOutcome> => {
      await pause()
      const kept = [...projects.values()].find((each) => each.asks.some((ask) => ask.id === askId))
      const ask = kept?.asks.find((each) => each.id === askId)
      if (!kept || !ask) throw new Error("There's no such ask.")
      const settle = (state: GitHubAsk["state"]) => {
        const settled: GitHubAsk = { ...ask, state, answeredAt: new Date().toISOString() }
        kept.asks = kept.asks.map((each) => (each.id === askId ? settled : each))
        return settled
      }
      if (scene === "refused") return { ask: settle("expired"), already: true }
      if (othersAnswered) {
        othersAnswered = false
        return { ask: settle("allowed-thread"), already: true }
      }
      if (answer === "project" && kept.reach.mode !== "installation") {
        const current = kept.reach.mode === "chosen" ? kept.reach.repositories : []
        kept.reach = { mode: "chosen", repositories: [...current, ...ask.repositories.filter((name) => !current.includes(name))] }
      }
      return { ask: settle(answer === "thread" ? "allowed-thread" : answer === "project" ? "allowed-project" : "declined"), already: false }
    },
  }
}

/** The desk's `?mock` bridge methods: `github-reach=<scene>`, only the project's repository by default. */
export function mockGitHubReach() {
  const store = mockGitHubReachStore(githubReachScene(new URLSearchParams(globalThis.location?.search).get("github-reach")))
  return {
    githubReach: store.read,
    githubReachSave: store.save,
    githubAsks: store.asks,
    githubAskAnswer: store.answer,
  }
}
