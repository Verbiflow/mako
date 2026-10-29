import type { CloudTurnOn, TurnOnAgent, TurnOnProject, TurnOnStep } from "@mako/host/contracts/cloud-turn-on"
import type { HostEvent } from "@/lib/types"

const PROJECT = "/Users/you/mako"
const REPOSITORY = "https://github.com/acme/mako"
const OTHERS: TurnOnProject[] = [
  { folder: "/Users/you/api", repository: "https://github.com/acme/api", base: { state: "ready", madeAt: new Date().toISOString() } },
  { folder: "/Users/you/site", repository: "https://github.com/acme/site", base: { state: "making", since: new Date().toISOString() } },
]

/**
 * Turning the cloud on, for `?mock&cloud=signed-in&invited` (`turnon=`): by default it's on, every step done, so a desk
 * looked at for something else shows no line; `live` plays from the moment the cloud came on, each step done at the
 * pace a local cloud measured, so the line can be watched moving; `starting` holds its first second, `ready` once a
 * Thread can run with the rest going, `warming` with a machine coming up for the first Thread, `stuck` with an agent
 * signed out here (and, only in Details, a base given up and Sessions retrying), `private` with the most recent
 * project private, `on` with every step done, `none` with no recent project on GitHub. With `carried=unasked`, the
 * first project's files Git leaves out are asked about. Without `invited`, the account waits for its invite; Check
 * now hears it a moment later.
 */
export function mockCloudTurnOn(emit: (event: HostEvent) => void, entitled: () => boolean, grant: () => void) {
  const params = new URLSearchParams(globalThis.location?.search)
  const scenario = params.get("turnon")
  const since = Date.now()
  const at = (seconds: number) => since + seconds * 1_000
  const agents = (states: Array<TurnOnAgent["state"]>): TurnOnAgent[] =>
    ["claude", "codex", "grok"].map((harness, index) => {
      const state = states[index] ?? "in-cloud"
      return state === "stuck" ? { harness, state, problem: "the provider refused the refresh token (400: invalid_grant)" } : { harness, state }
    })
  const history = (inCloud: number, todayIn: number, state: TurnOnStep["state"] = "working"): TurnOnStep => ({ id: "history", state, threads: 117, inCloud, today: { threads: 11, inCloud: todayIn }, paused: false, failures: 0, correlationIds: [], ...(state === "done" && { at: at(41) }) })
  const signedIn: TurnOnStep[] = [
    { id: "account", state: "done", connection: "connected", at: since },
    { id: "plan", state: "done", at: since },
  ]

  /** The line `seconds` after the cloud came on, at the pace a local cloud measured. */
  const live = (seconds: number): CloudTurnOn => {
    const agentsDone = seconds >= 2.4
    const baseDone = seconds >= 11.2
    const historyIn = Math.min(117, Math.max(0, Math.round((seconds - 1.2) * 3.1)))
    const steps: TurnOnStep[] = [
      ...signedIn,
      agentsDone
        ? { id: "agents", state: "done", sharing: true, agents: agents([]), at: at(2.4) }
        : { id: "agents", state: "working", sharing: true, agents: agents(seconds >= 1.1 ? ["in-cloud", "sending", "sending"] : ["sending", "sending", "sending"]) },
      baseDone
        ? { id: "projects", state: "done", projects: [{ folder: PROJECT, repository: REPOSITORY, base: { state: "ready", madeAt: new Date(at(11.2)).toISOString() } }, ...OTHERS.map((project) => ({ ...project, base: { state: "ready" as const, madeAt: new Date().toISOString() } }))], at: at(11.2) }
        : { id: "projects", state: "working", projects: [{ folder: PROJECT, repository: REPOSITORY, base: { state: "making", since: new Date(since).toISOString() } }, ...OTHERS] },
      historyIn >= 117 ? history(117, 11, "done") : history(historyIn, Math.min(11, historyIn)),
      agentsDone ? { id: "thread", state: "yours", folder: PROJECT, repository: REPOSITORY, fix: "start-thread" } : { id: "thread", state: "yours", folder: PROJECT, repository: REPOSITORY, fix: "start-thread" },
    ]
    const turnOn: CloudTurnOn = { phase: agentsDone ? "ready" : "turning-on", since, steps }
    if (agentsDone) turnOn.readyAt = at(2.4)
    return turnOn
  }

  const on = (): CloudTurnOn => ({
    phase: "on",
    since,
    readyAt: at(2.4),
    onAt: at(83),
    steps: [
      ...signedIn,
      { id: "agents", state: "done", sharing: true, agents: agents([]), at: at(2.4) },
      { id: "projects", state: "done", projects: [{ folder: PROJECT, repository: REPOSITORY, base: { state: "ready", madeAt: new Date().toISOString() } }, ...OTHERS.map((project) => ({ ...project, base: { state: "ready" as const, madeAt: new Date().toISOString() } }))], at: at(11.2) },
      history(117, 11, "done"),
      { id: "thread", state: "done", at: at(83) },
    ],
  })

  const fixed = (): CloudTurnOn => {
    const ready: TurnOnStep[] = [
      ...signedIn,
      { id: "agents", state: "done", sharing: true, agents: agents([]), at: at(2.4) },
      { id: "projects", state: "working", projects: [{ folder: PROJECT, repository: REPOSITORY, base: { state: "making", since: new Date(since).toISOString() } }, ...OTHERS] },
      history(41, 11),
      { id: "thread", state: "yours", folder: PROJECT, repository: REPOSITORY, fix: "start-thread" },
    ]
    switch (scenario) {
      case "starting":
        return live(0.4)
      case "ready":
        return { phase: "ready", since, readyAt: at(2.4), steps: ready }
      case "warming":
        return { phase: "ready", since, readyAt: at(2.4), steps: ready.map((step) => (step.id === "thread" ? { ...step, machine: "warming" as const } : step)) }
      case "stuck":
        // An agent signed out on this Mac: the one thing to ask. Behind it, a base given up and Sessions retrying,
        // which Mako handles by itself and so says only in Details.
        return {
          phase: "ready",
          since,
          readyAt: at(2.6),
          steps: [
            ...signedIn,
            { id: "agents", state: "stuck", sharing: true, agents: agents(["stuck"]), fix: "sign-in-agent" },
            { id: "projects", state: "stuck", projects: [{ folder: PROJECT, repository: REPOSITORY, base: { state: "ready", madeAt: new Date().toISOString() } }, { ...OTHERS[0]!, base: { state: "failed", message: "the clone took more than 10 minutes" } }, OTHERS[1]!], problem: "the clone took more than 10 minutes", fix: "retry-bases" },
            { id: "history", state: "stuck", threads: 117, inCloud: 96, today: { threads: 11, inCloud: 11 }, paused: false, failures: 2, problem: "The archive's storage couldn't be read; try again (POST /sessions/with-chunks answered 503, 4 tries, correlation 6f1c2d3e-8b9a-4c7d-a1e2-f3b4c5d6e7f8)", correlationIds: ["6f1c2d3e-8b9a-4c7d-a1e2-f3b4c5d6e7f8"], fix: "copy-details" },
            { id: "thread", state: "yours", folder: PROJECT, repository: REPOSITORY, fix: "start-thread" },
          ],
        }
      case "private":
        // The most recent project is private: said plainly, with no button, and the first Thread goes to the next.
        return {
          phase: "ready",
          since,
          readyAt: at(2.4),
          steps: [
            ...signedIn,
            { id: "agents", state: "done", sharing: true, agents: agents([]), at: at(2.4) },
            { id: "projects", state: "done", projects: [{ folder: PROJECT, repository: REPOSITORY, base: { state: "failed", message: "the clone failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled", reason: "no-access" } }, ...OTHERS.map((project) => ({ ...project, base: { state: "ready" as const, madeAt: new Date().toISOString() } }))], at: at(9.8) },
            history(117, 11, "done"),
            { id: "thread", state: "yours", folder: OTHERS[0]!.folder, repository: OTHERS[0]!.repository, fix: "start-thread" },
          ],
        }
      case "private-access":
        // The most recent project is private, and the cloud's GitHub App is what it lacks: one button, to GitHub.
        return {
          phase: "ready",
          since,
          readyAt: at(2.4),
          steps: [
            ...signedIn,
            { id: "agents", state: "done", sharing: true, agents: agents([]), at: at(2.4) },
            { id: "projects", state: "done", projects: [{ folder: PROJECT, repository: REPOSITORY, base: { state: "waiting", message: "the clone failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled", reason: "no-access", install: "https://github.com/apps/mako/installations/new" } }, ...OTHERS.map((project) => ({ ...project, base: { state: "ready" as const, madeAt: new Date().toISOString() } }))], at: at(9.8) },
            history(117, 11, "done"),
            { id: "thread", state: "yours", folder: OTHERS[0]!.folder, repository: OTHERS[0]!.repository, fix: "start-thread" },
          ],
        }
      case "none":
        return {
          phase: "ready",
          since,
          readyAt: at(2.4),
          steps: [...signedIn, { id: "agents", state: "done", sharing: true, agents: [], at: at(1.6) }, { id: "projects", state: "done", projects: [], at: at(0.9) }, history(41, 11), { id: "thread", state: "yours" }],
        }
      case "on":
        return on()
      case "live":
        return live(0)
      default:
        return on()
    }
  }

  const waiting: CloudTurnOn = {
    phase: "no-cloud",
    steps: [
      { id: "account", state: "done", connection: "connected" },
      { id: "plan", state: "yours", fix: "check-plan" },
      { id: "agents", state: "later", sharing: true, agents: [] },
      { id: "projects", state: "later", projects: [] },
      { id: "history", state: "later", threads: 0, inCloud: 0, today: { threads: 0, inCloud: 0 }, paused: false, failures: 0, correlationIds: [] },
      { id: "thread", state: "later" },
    ],
  }
  let current: CloudTurnOn = entitled() ? fixed() : waiting
  let timer: ReturnType<typeof setInterval> | undefined
  let granted = false
  const play = () => {
    if ((scenario !== "live" && !granted) || timer) return
    const began = Date.now()
    timer = setInterval(() => {
      const seconds = (Date.now() - began) / 1_000
      current = live(seconds)
      emit({ type: "cloud-turn-on", turnOn: current })
      if (seconds > 45) clearInterval(timer)
    }, 400)
  }
  if (entitled()) play()

  return {
    cloudTurnOn: async () => current,
    cloudTurnOnCheck: async () => {
      await new Promise((resolve) => setTimeout(resolve, 700))
      if (params.has("grant")) {
        granted = true
        grant()
        current = live(0)
        play()
      }
      return current
    },
    cloudTurnOnRetryBases: async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      current = { ...current, steps: current.steps.map((step) => (step.id === "projects" ? { ...step, state: "working" as const, problem: undefined, fix: undefined, projects: step.projects.map((project) => (project.base.state === "failed" || ("reason" in project.base && project.base.reason === "no-access") ? { ...project, base: { state: "making" as const, since: new Date().toISOString() } } : project)) } : step)) }
      return current
    },
  }
}
