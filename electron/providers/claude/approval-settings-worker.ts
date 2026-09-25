import { parentPort, workerData } from "node:worker_threads"
import { resolveSettings } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { hasClaudeTelemetrySettings } from "./approval-telemetry-settings.js"

const input = z.object({ cwd: z.string(), settingSources: z.array(z.enum(["user", "project", "local"])).optional() }).parse(workerData)
// The worker has the launch account's environment, including CLAUDE_CONFIG_DIR.
// Never return settings or credentials to the host, only the compatibility result.
try {
  const resolved = await resolveSettings(input)
  parentPort?.postMessage(!resolved.sources.some(source => hasClaudeTelemetrySettings(source.settings)))
} catch { parentPort?.postMessage(false) }
