// A seventh harness the session flows run like the six real ones
// (`test-session-flows.mjs --stand-in`): one `HarnessDefinition`, installed
// through `installHarness` alone, whose ACP agent is `stand-in-agent.mjs`,
// and one saved-history reader the flows' catalog is given beside Mako's.
// It is built from the host's compiled modules, so it is installed into the
// same registries the flows host reads.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

export const STAND_IN = "seventh"

const AGENT = fileURLToPath(new URL("./stand-in-agent.mjs", import.meta.url))
const PLAN_TOOL = "write_plan"
const BUILD = "build"
const PlanCall = z.object({
  sessionUpdate: z.literal("tool_call"), title: z.literal(PLAN_TOOL), toolCallId: z.string(), rawInput: z.object({ plan: z.string() }),
})
const SavedLine = z.object({ params: z.object({ sessionId: z.string(), update: z.looseObject({ sessionUpdate: z.string() }) }) })
const UserChunk = z.object({ sessionUpdate: z.literal("user_message_chunk"), content: z.object({ type: z.literal("text"), text: z.string() }) })

/**
 * Installs the stand-in into `providerHost` with the harness `context` it was made with, its sessions kept in `store`.
 * Returns its provider id and its saved-history reader, for the catalog.
 */
export async function installStandIn({ load, providerHost, context, store }) {
  const { AcpSavedTurns } = await load("packages/sessions/dist/acp-saved-turns.js")
  const { installHarness, lacks } = await load("packages/host/dist/harnesses/harness-definition.js")
  const { harnessLacks } = await load("packages/host/dist/harnesses/live-capabilities.js")
  const { HARNESS_FEATURE_KEYS, HARNESS_FEATURES, makosOwn, native, shownAs } = await load("packages/host/dist/contracts/harness-features.js")
  const { withEarlierExchanges } = await load("packages/host/dist/contracts/live-side-questions.js")
  const { createAcpLiveDriver } = await load("packages/host/dist/harnesses/acp-live-driver.js")
  const { acpDecoderSource } = await load("packages/host/dist/harnesses/acp-decoder-source.js")
  const { fileResumeEvidence } = await load("packages/host/dist/harnesses/native-continuation.js")
  const { availableProviderProfile } = await load("packages/host/dist/harnesses/profile-loader.js")
  const { NO_NATIVE_PROMPT_IDENTITY } = await load("packages/host/dist/contracts/native-prompt-identity.js")
  mkdirSync(store, { recursive: true })
  const source = (nativeId) => join(store, `${nativeId}.jsonl`)

  /** The agent holds `<id>.pid` while a live process has the session open. */
  const processProbe = {
    provider: STAND_IN,
    async probe() {
      const sessions = readdirSync(store).filter((name) => name.endsWith(".pid")).flatMap((name) => {
        const pid = Number(readFileSync(join(store, name), "utf8"))
        if (!alive(pid)) return []
        const nativeId = name.slice(0, -".pid".length)
        return [{ nativeId, path: source(nativeId), status: "open", detail: `stand-in process ${pid}` }]
      })
      return { kind: "available", sessions }
    },
  }

  /** The plan is `write_plan`'s input, and its permission request builds it. */
  class StandInPlans {
    proposed = new Set()
    update(update) {
      const call = PlanCall.safeParse(update).data
      if (!call) return []
      this.proposed.add(call.toolCallId)
      return [{ kind: "proposed-plan", id: call.toolCallId, text: call.rawInput.plan, status: "proposed", replace: true }]
    }
    approval(request) {
      const id = request.toolCall.toolCallId
      return this.proposed.has(id) && request.options.some((option) => option.optionId === BUILD) ? { plan: id, approve: BUILD } : undefined
    }
  }

  const acp = {
    provider: STAND_IN,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    resume: {
      kind: "native",
      via: "ACP `session/load`, which replays the session's saved updates.",
      wake: "The next message starts a new stand-in agent that loads the session.",
      ...fileResumeEvidence(processProbe),
      locate: ({ nativeId }) => (existsSync(source(nativeId)) ? source(nativeId) : undefined),
    },
    fork: { kind: "import", via: "Mako writes the conversation up to the fork as a new session in the stand-in's store, which the agent loads." },
    questions: { kind: "unavailable", reason: "The stand-in agent asks no questions." },
    approvalEvidence: { kind: "submission-only", reason: "It asks through session/request_permission and keeps no record of the answer." },
    planning: {
      via: "mode", mode: "plan", proposal: `${PLAN_TOOL}'s plan, built by answering its permission request`,
      feedback: { kind: "next-message", reason: "Its plan approval is ACP's permission request, whose answer is an option id." },
    },
    agents: { kind: "unavailable", reason: "The stand-in agent starts no subagents." },
    compaction: { kind: "unavailable", reason: "The stand-in agent never compacts." },
    goals: { kind: "mako", reason: "The stand-in agent has no goal of its own." },
    review: { kind: "mako", reason: "The stand-in agent has no review of its own." },
    sideQuestions: {
      kind: "native",
      via: "Its `_stand-in/btw`, which streams the answer on a side chain and keeps it out of the session.",
      chain: (notification) => notification._meta?.["stand-in/chain"] === "side",
      async ask(peer, { question, earlier, stream }) {
        const stopListening = peer.listen(({ update }) => {
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") stream(update.content.text)
        })
        try {
          const reply = await peer.extMethod("_stand-in/btw", { sessionId: peer.sessionId, question: withEarlierExchanges(question, earlier) })
          return z.object({ answer: z.string() }).parse(reply).answer
        } finally {
          stopListening()
        }
      },
    },
    backgroundStop: { kind: "ends-with-turn", evidence: "Its only tool runs in the foreground, and Stop's session/cancel ends it." },
    steering: { kind: "supported", via: "A prompt sent while a turn runs joins it.", wire: "concurrent-prompt" },
    access: { native: { full: "full", plan: "plan" }, default: "full" },
    nativeModes: [{ id: "full", name: "Full access" }, { id: "plan", name: "Plan" }],
    plans: () => new StandInPlans(),
    available: () => true,
    async launch() {
      return {
        command: process.execPath,
        args: [AGENT],
        configureEnvironment(env) {
          env.ELECTRON_RUN_AS_NODE = "1"
          env.STAND_IN_STORE = store
        },
      }
    },
  }

  const profile = {
    provider: STAND_IN,
    label: "Stand-in Agent",
    defaults: { work: [{ model: "stand-in" }] },
    transport: "acp",
    cacheKey: () => STAND_IN,
    load: async () => availableProviderProfile(profile, { models: [{ id: "stand-in", label: "Stand-in", options: [] }] }),
  }

  const none = lacks("The stand-in has only what the session flows drive.")
  const unreported = harnessLacks("The stand-in agent sends no usage.")
  installHarness(providerHost, {
    provider: STAND_IN,
    presentation: { mark: { viewBox: "0 0 16 16", paths: [{ d: "M0 0h16v16H0zM4 4v8h8V4z", fillRule: "evenodd" }], tint: "#2F6F4E" } },
    diagnostics: { sdk: "@agentclientprotocol/sdk" },
    usage: { context: unreported, window: unreported, compaction: unreported, tokens: unreported, cost: unreported, missedCalls: unreported, resetCredits: unreported, balance: unreported, limitSwitch: unreported, toolSpend: unreported },
    features: {
      ...Object.fromEntries(HARNESS_FEATURE_KEYS.map((key) => [key, { mako: HARNESS_FEATURES[key].mako ? makosOwn() : harnessLacks("The stand-in has only what the session flows drive.") }])),
      sideQuestions: { native: native("btw", "its `_stand-in/btw` extension"), mako: shownAs("The side panel asks the stand-in's own side question.") },
    },
    hooks: none,
    commands: none,
    toolEditing: none,
    skillEditing: none,
    mcpEditing: none,
    live: createAcpLiveDriver(acp, providerHost, context),
    decoder: acpDecoderSource(acp),
    profile,
    accounts: none,
    acp,
    nativeRunner: none,
    processProbe,
    mcp: none,
    skills: none,
    connection: none,
    updates: none,
    usageHistory: none,
    artifactPreview: none,
    unique: [],
  })

  /**
   * Its store keeps the wire: each line one `session/update` it sent. The
   * person's message opens a turn, which runs until the next one.
   */
  const reader = () => {
    const stamp = (path) => {
      const { size, mtimeMs } = statSync(path)
      return { path, bytes: size, mtimeMs }
    }
    const updates = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      const saved = SavedLine.safeParse(JSON.parse(line)).data
      return saved ? [saved.params] : []
    })
    const refOf = (file, saved) => ({
      harness: STAND_IN, nativeId: basename(file.path, ".jsonl"), path: file.path, bytes: file.bytes,
      title: saved.map(({ update }) => UserChunk.safeParse(update).data?.content.text).find(Boolean),
      updatedAt: new Date(file.mtimeMs).toISOString(),
    })
    return {
      harness: STAND_IN,
      displayName: profile.label,
      roots: () => [store],
      discover: async () => readdirSync(store).filter((name) => name.endsWith(".jsonl")).map((name) => stamp(join(store, name))),
      stat: async (path) => existsSync(path) ? stamp(path) : null,
      peek: async (file) => refOf(file, updates(file.path)),
      read: async (path) => {
        if (!existsSync(path)) return null
        const saved = updates(path)
        const turns = new AcpSavedTurns({ plans: () => new StandInPlans() })
        for (const notification of saved) {
          const prompt = UserChunk.safeParse(notification.update).data
          if (!prompt) {
            turns.update(notification, undefined)
            continue
          }
          turns.commit()
          turns.prompted({ text: prompt.content.text, attachments: [] })
        }
        return { ref: refOf(stamp(path), saved), entries: turns.done() }
      },
    }
  }
  return { provider: STAND_IN, reader }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
