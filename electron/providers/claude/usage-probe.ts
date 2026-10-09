import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { tmpdir } from "node:os"
import type { AccountUsage } from "../../account-types.js"
import { claudeRuntime } from "./runtime.js"
import { heavy } from "../../heavy-packages.js"

const PROBE_TIMEOUT_MS = 20_000

/**
 * Claude Code's own `/usage` reading, from a Claude that starts, answers
 * and stops without a prompt or a saved session. It refreshes the account's
 * sign-in the way Claude always does, so a token that expired since Claude
 * last ran reads again here, and the next direct read finds the new one.
 * The SDK marks the request experimental; a failure falls back to waiting
 * for the account's next run.
 */
export async function claudeProbeUsage(
  env: NodeJS.ProcessEnv,
  parse: (contents: string) => Extract<AccountUsage, { status: "ok" }>
): Promise<AccountUsage | null> {
  const runtime = claudeRuntime(env)
  let release: () => void = () => {}
  const idle = new Promise<void>((resolve) => { release = resolve })
  // A prompt stream that never sends: Claude starts and waits, answering control requests.
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: () => idle.then(() => ({ done: true, value: undefined })) }),
  }
  const { query } = await heavy.claudeAgentSdk.load("claude usage")
  const claude = query({
    prompt,
    options: {
      cwd: tmpdir(),
      env,
      persistSession: false,
      settingSources: [],
      pathToClaudeCodeExecutable: runtime?.kind === "configured" ? runtime.executable : undefined,
    },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      claude.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude did not report usage in time")), PROBE_TIMEOUT_MS)
      }),
    ])
    if (!response.rate_limits_available || !response.rate_limits)
      return { status: "unavailable", detail: "This Claude login has no plan limits" }
    const usage = parse(JSON.stringify(response.rate_limits))
    if (response.subscription_type && usage.plan === undefined) usage.plan = response.subscription_type
    return usage
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    release()
    claude.close()
  }
}
