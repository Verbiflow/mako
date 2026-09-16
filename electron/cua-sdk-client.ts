import {
  ConfiguredDriverOptions,
  CuaDriver,
  RuntimeAuthorizationOptions,
  SessionPermissionMode,
  type CuaDriverLike,
} from "@trycua/cua-driver"
import { ToolSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { JsonObject } from "./codex-app-json.js"
import {
  ComputerDriverResultSchema,
  type ComputerDriverCallOptions,
  type ComputerDriverClient,
  type ComputerDriverProcess,
  type ComputerDriverResult,
} from "./computer-driver-client.js"

const catalogSchema = z.object({ tools: z.array(z.json()) }).loose()

function configuredOptions(): ConfiguredDriverOptions {
  return ConfiguredDriverOptions.new({
    claudeCodeCompatibility: false,
    authorization: RuntimeAuthorizationOptions.new({
      allowedModes: [SessionPermissionMode.Standard],
      compatibilityMode: SessionPermissionMode.Standard,
      unrestrictedAcknowledged: false,
      maxSessionTtlSeconds: 60n * 60n,
      maxIdleTtlSeconds: 10n * 60n,
    }),
  })
}

function activeSignal(
  options: ComputerDriverCallOptions
): AbortSignal | undefined {
  const timeout =
    options.timeout === undefined
      ? undefined
      : AbortSignal.timeout(options.timeout)
  if (options.signal && timeout)
    return AbortSignal.any([options.signal, timeout])
  return options.signal ?? timeout
}

class CuaSdkComputerDriverClient implements ComputerDriverClient {
  private readonly driver: CuaDriverLike
  private readonly listeners = new Set<() => void>()
  private closed = false

  constructor(driver: CuaDriverLike) {
    this.driver = driver
  }

  async listTools(): Promise<Tool[]> {
    const catalog = catalogSchema.parse(
      JSON.parse(await this.driver.listToolsJson())
    )
    return catalog.tools.map((tool) => ToolSchema.parse(tool))
  }

  async callTool(
    name: string,
    args: JsonObject,
    options: ComputerDriverCallOptions = {}
  ): Promise<ComputerDriverResult> {
    const signal = activeSignal(options)
    const result = await this.driver.callTool(
      name,
      JSON.stringify(args),
      signal ? { signal } : undefined
    )
    return ComputerDriverResultSchema.parse(JSON.parse(result.rawJson))
  }

  onClose(listener: () => void): void {
    this.listeners.add(listener)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.driver.shutdown()
    for (const listener of this.listeners) listener()
    this.listeners.clear()
  }
}

export function connectCuaSdkComputerDriver(
  process: ComputerDriverProcess
): Promise<ComputerDriverClient> {
  // The connector contract carries the executable used by daemon transports;
  // direct SDK mode deliberately owns no child process.
  void process
  const driver = CuaDriver.createConfigured(configuredOptions())
  return Promise.resolve(new CuaSdkComputerDriverClient(driver))
}
