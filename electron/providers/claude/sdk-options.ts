import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { accountEnv } from "../../accounts.js"
import { resolveExecutable } from "../../executable.js"
import { acpMcpServers } from "../../mcp-runtime.js"
import type { ProviderStartOptions } from "../live-driver.js"
import { ClaudeModeSchema, ClaudeTuningSchema } from "./input.js"
import type { ProviderLaunchTrace } from "../../provider-launch.js"

export async function claudeSdkOptions(
  cwd: string,
  input: ProviderStartOptions,
  trace: ProviderLaunchTrace
): Promise<Options> {
  const env = await trace.step("account", () => accountEnv("claude", process.env))
  const executable = trace.sync("runtime-discovery", () => env.CLAUDE_CODE_EXECUTABLE
    ? resolveExecutable(env.CLAUDE_CODE_EXECUTABLE, env)
    : undefined)
  if (env.CLAUDE_CODE_EXECUTABLE && !executable)
    throw new Error("The configured Claude Code executable is unavailable")
  const tuning = ClaudeTuningSchema.parse(input.tuning?.options ?? {})
  const initialMode = ClaudeModeSchema.safeParse(input.modeId)
  if (tuning.agentTeams !== undefined)
    env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = tuning.agentTeams ? "1" : "0"
  if (!input.mcpSnapshot)
    throw new Error("The host did not provide MCP discovery")
  const snapshot = await trace.step("mcp-preparation", input.mcpSnapshot)
  const mcpServers: NonNullable<Options["mcpServers"]> = {}
  for (const server of acpMcpServers(
    snapshot,
    "claude",
    ["stdio", "http"],
    input.conversationTools?.control,
    input.conversationId
  )) {
    if ("command" in server) {
      mcpServers[server.name] = {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: Object.fromEntries(
          server.env.map(({ name, value }) => [name, value])
        ),
      }
    } else if (server.type === "http") {
      mcpServers[server.name] = {
        type: "http",
        url: server.url,
        headers: Object.fromEntries(
          server.headers.map(({ name, value }) => [name, value])
        ),
      }
    }
  }
  if (input.conversationTools)
    mcpServers["mako-conversations"] = {
      type: "http",
      url: input.conversationTools.url,
      headers: { Authorization: `Bearer ${input.conversationTools.token}` },
    }
  return {
    cwd,
    env,
    pathToClaudeCodeExecutable: executable ?? undefined,
    resume: input.fork?.nativeId ?? input.resume,
    sessionId: input.fork || !input.resume ? input.conversationId : undefined,
    forkSession: input.fork ? true : undefined,
    resumeSessionAt: input.fork?.runId,
    model: input.tuning?.model,
    effort: tuning.effort,
    // The launch tier, when one was chosen. The bypass capability is always
    // granted at launch so a later switch to Full access through
    // setPermissionMode is accepted; the mode itself stays explicit.
    permissionMode: initialMode.success ? initialMode.data : undefined,
    allowDangerouslySkipPermissions: true,
    settings: tuning.fast === undefined ? undefined : { fastMode: tuning.fast },
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    mcpServers,
    includePartialMessages: true,
    title: input.title,
  }
}
