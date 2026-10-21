import { parentPort } from "node:worker_threads"
import { resolveSettings } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { hasClaudeTelemetrySettings } from "./approval-telemetry-settings.js"

const Check = z.object({
  id: z.number(),
  env: z.record(z.string(), z.string()),
  cwd: z.string(),
  settingSources: z.array(z.enum(["user", "project", "local"])).optional(),
})

// The SDK is loaded once, here: each check then reads only the settings files (1 ms, against 0.3–0.44 s for a worker
// that loads it every start, on a copy, 2026-10-20). Checks run one at a time, each under its launch's environment:
// the SDK reads `CLAUDE_CONFIG_DIR` and the files again on every call (`test-claude-permission-settings.mjs` holds it to that).
// Never return settings or credentials to the host, only the compatibility result.
let queue = Promise.resolve()
parentPort?.on("message", (message) => {
  const check = Check.safeParse(message)
  if (check.success) queue = queue.then(() => answer(check.data))
})
parentPort?.postMessage({ ready: true })

async function answer(check: z.infer<typeof Check>): Promise<void> {
  for (const name of Object.keys(process.env)) delete process.env[name]
  Object.assign(process.env, check.env)
  let compatible = false
  try {
    const resolved = await resolveSettings({ cwd: check.cwd, settingSources: check.settingSources })
    compatible = !resolved.sources.some(source => hasClaudeTelemetrySettings(source.settings))
  } catch { /* Unreadable settings leave Claude's telemetry alone: not compatible. */ }
  parentPort?.postMessage({ id: check.id, compatible })
}
