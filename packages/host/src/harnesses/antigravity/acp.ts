import { inclusiveTokens } from "@mako/sessions/harnesses"
import { openReadOnly } from "@mako/sessions/read-only-sqlite"
import { z } from "zod"
import { agyDataDirectory } from "@mako/sessions"
import { antigravityResume } from "./resume.js"
import { resolveExecutable } from "../../base/executable.js"
import { NO_NATIVE_PROMPT_IDENTITY } from "../../contracts/native-prompt-identity.js"
import type { ProviderAcpSource } from "../acp-source.js"

export function agyArgs(env?: NodeJS.ProcessEnv): string[] {
  return ["acp", "--process-per-session", ...(env?.GEMINI_API_KEY ? ["--app-data-dir", agyDataDirectory(env)] : [])]
}
const promptReply = z.object({ usage: z.object({
  inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  cachedReadTokens: z.number().nullish(), cachedWriteTokens: z.number().nullish(), thoughtTokens: z.number().nullish(),
}) })
const planArtifact = z.object({
  Path: z.string().regex(/(?:^|[\\/])implementation_plan\.md$/i),
  Content: z.string().min(1),
  ArtifactMetadata: z.object({ UserFacing: z.literal(true), RequestFeedback: z.literal(true) }),
})
const terminalStep = z.object({ idx: z.number(), step_type: z.number() })
function lastStep(path?: string) {
  if (!path) return undefined
  try {
    const { database } = openReadOnly(path, { timeout: 150 })
    try { return terminalStep.safeParse(database.prepare("SELECT idx, step_type FROM steps ORDER BY idx DESC LIMIT 1").get()).data }
    finally { database.close() }
  } catch { return undefined }
}

export const antigravityAcp: ProviderAcpSource = {
  provider: "antigravity",
  promptUsage(response) {
    const counts = promptReply.safeParse(response).data?.usage
    return counts ? [{ kind: "spent", tokens: inclusiveTokens({ input: counts.inputTokens, output: counts.outputTokens,
      cacheRead: counts.cachedReadTokens, cacheWrite: counts.cachedWriteTokens, reasoning: counts.thoughtTokens }) }] : []
  },
  watchPromptFailure(locate) {
    const before = lastStep(locate())?.idx ?? -1
    return () => {
      const after = lastStep(locate())
      return after && after.idx > before && after.step_type === 17 ? "Antigravity reported an executor error. See its message in the conversation." : undefined
    }
  },
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  resume: antigravityResume,
  fork: { kind: "transcript", via: "Mako starts a fresh Antigravity session with the retained turns." },
  questions: { kind: "request", via: "Antigravity sends choices through ACP permission requests." },
  approvalEvidence: { kind: "submission-only", reason: "The ACP client submits the selected option." },
  plans: () => ({
    update(update, sessionId) {
      if ((update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") || update.status !== "completed") return []
      const artifact = planArtifact.safeParse(update.rawInput).data
      return artifact ? [{ kind: "proposed-plan", id: sessionId + "/implementation_plan.md", text: artifact.Content, status: "proposed", replace: true }] : []
    },
  }),
  planning: { via: "mode", mode: "plan", proposal: "A completed implementation_plan.md artifact that requests feedback.",
    feedback: { kind: "next-message", reason: "An ACP permission answer carries the selected option." } },
  nativeRouting: { kind: "words", reason: "Mako's instructions direct delegation to its Fins." },
  layer: {
    instructions: { kind: "fallback", via: "prompt-note", loses: "The agent reads Mako's instructions with the message." },
    toolServing: { kind: "native", via: "http-mcp", how: "HTTP MCP servers passed to each ACP session.", inUse: true },
    removal: { kind: "fallback", via: "words", loses: "Native tools stay available." },
    interception: { kind: "fallback", via: "words", loses: "The agent decides which tool to call." },
    subagents: { kind: "fallback", via: "words", loses: "Native subagents choose whether to follow the delegation instructions." },
    hooks: { kind: "absent", reason: "Mako installs no Antigravity hooks." },
    personSetup: "kept",
  },
  modelRoutes: { kind: "absent", reason: "The agent lists the models for its Google sign-in or Gemini API key." },
  accountContinuation: { kind: "new-session", reason: "Changing credentials starts a session under the new account." },
  agents: { kind: "not-built", reason: "ACP tool updates do not identify a child session." },
  backgroundStop: { kind: "unobserved", reason: "Antigravity does not report background task lifetimes over ACP." },
  compaction: { kind: "unavailable", reason: "Mako has no completion receipt for Antigravity's /compact command." },
  goals: { kind: "mako", reason: "Mako drives the goal between turns." },
  review: { kind: "mako", reason: "Mako sends the review prompt." },
  sideQuestions: { kind: "not-built", reason: "Mako has no separate Antigravity side session." },
  steering: { kind: "unavailable", reason: "Messages wait for the active ACP prompt to finish." },
  access: { default: "ask", native: { ask: "default", edits: "accept-edits", plan: "plan" } },
  nativeModes: [{ id: "default", name: "Default" }, { id: "accept-edits", name: "Accept edits" }, { id: "plan", name: "Plan" }],
  available: () => Boolean(resolveExecutable("agy")),
  async launch({ env }) {
    const command = resolveExecutable("agy", env)
    return command ? { command, args: agyArgs(env), configureEnvironment() {},
      ...env?.GEMINI_API_KEY && { authenticateWith: "gemini-api-key" } } : null
  },
}
