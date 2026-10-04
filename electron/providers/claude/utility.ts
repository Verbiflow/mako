import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UtilityModelError } from "../../utility-model-error.js"
import type { ProviderUtilityRunner } from "../utility-runner.js"
import { ClaudeTuningSchema } from "./input.js"
import { claudeRuntime } from "./runtime.js"
import { spawnClaudeProcess } from "./sdk-process.js"

/**
 * One prompt through the Claude Agent SDK on the account Claude Code is
 * signed in with: no tools, one turn, no settings or MCP servers loaded, an
 * empty folder to start in, and `persistSession: false`, so nothing is
 * written under `~/.claude/projects` and no session can be resumed.
 */
export const claudeUtilityRunner: ProviderUtilityRunner = {
  provider: "claude",
  async complete(request) {
    const { resolveAccountLaunch } = await import("../../accounts.js")
    const { env } = await resolveAccountLaunch("claude", process.env)
    const runtime = claudeRuntime(env)
    if (!runtime) throw new UtilityModelError("request", "Claude Code is unavailable. Reinstall Mako or set CLAUDE_CODE_EXECUTABLE.")
    const { query } = await import("@anthropic-ai/claude-agent-sdk")
    const tuning = ClaudeTuningSchema.parse(request.options)
    const cwd = await mkdtemp(join(tmpdir(), "mako-utility-"))
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.signal.addEventListener("abort", abort, { once: true })
    try {
      const run = query({
        prompt: request.prompt,
        options: {
          cwd,
          env,
          model: request.model,
          effort: tuning.effort,
          // No setting sources are loaded, so the fast lane is off unless asked for.
          settings: tuning.fast ? { fastMode: true } : undefined,
          pathToClaudeCodeExecutable: runtime.kind === "configured" ? runtime.executable : undefined,
          spawnClaudeCodeProcess: (options) => spawnClaudeProcess(options).child,
          systemPrompt: request.instructions,
          tools: [],
          // A structured reply is a tool call the SDK answers, then the turn that ends it.
          maxTurns: request.schema ? 3 : 1,
          persistSession: false,
          settingSources: [],
          mcpServers: {},
          outputFormat: request.schema ? { type: "json_schema", schema: request.schema } : undefined,
          abortController: controller,
        },
      })
      for await (const message of run) {
        if (message.type !== "result") continue
        if (message.subtype === "success" && !message.is_error) {
          if (request.schema) {
            if (message.structured_output === undefined) throw new UtilityModelError("output", "Claude returned no structured reply.")
            return JSON.stringify(message.structured_output)
          }
          const text = message.result.trim()
          if (!text) throw new UtilityModelError("output", "Claude returned no text.")
          return text
        }
        throw claudeFailure(message.subtype === "success" ? [message.result] : message.errors, message.subtype)
      }
      throw new UtilityModelError("request", "Claude Code ended without an answer.")
    } catch (error) {
      if (request.signal.aborted) throw new UtilityModelError("timeout", "The request was cancelled or timed out.")
      if (error instanceof UtilityModelError) throw error
      throw claudeFailure([error instanceof Error ? error.message : String(error)], "error_during_execution")
    } finally {
      request.signal.removeEventListener("abort", abort)
      await rm(cwd, { recursive: true, force: true })
    }
  },
}

function claudeFailure(details: readonly string[], subtype: string): UtilityModelError {
  const text = details.join(" ")
  if (/log ?in|sign ?in|auth|credential|api key|unauthori[sz]ed|forbidden|40[13]\b/i.test(text))
    return new UtilityModelError("auth", "Claude Code isn't signed in, or its sign-in expired. Sign in again in Settings › Agents.")
  if (/rate.?limit|usage limit|quota|overloaded|429\b/i.test(text))
    return new UtilityModelError("rate-limit", "Claude Code's usage limit was reached. Mako tries again later.")
  if (/prompt is too long|context/i.test(text))
    return new UtilityModelError("context", "The request exceeds this model's context window.")
  if (subtype === "error_max_turns" || subtype === "error_max_structured_output_retries")
    return new UtilityModelError("output", "Claude didn't give a reply in the shape asked for.")
  return new UtilityModelError("request", "Claude Code couldn't answer the request.")
}
