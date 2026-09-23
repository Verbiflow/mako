import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import type { JsonObject } from "./codex-app-json.js"
import { driverSchemaValidator } from "./driver-schema.js"
import { z } from "zod"

export const ComputerDriverResultSchema = z.looseObject({
  content: z.array(z.json()),
  structuredContent: z.record(z.string(), z.json()).optional(),
  isError: z.boolean().optional(),
})
export type ComputerDriverResult = z.infer<typeof ComputerDriverResultSchema>

/** Process transport for the currently installed native driver adapter. */
export interface ComputerDriverProcess {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface ComputerDriverCallOptions {
  signal?: AbortSignal
  timeout?: number
}

/**
 * The host-side native-driver seam. The patched driver's MCP process owns
 * native input and capture; policy, projection and programs stay in Mako.
 */
export interface ComputerDriverClient {
  listTools(): Promise<Tool[]>
  callTool(
    name: string,
    args: JsonObject,
    options?: ComputerDriverCallOptions
  ): Promise<ComputerDriverResult>
  onClose(listener: () => void): void
  close(): Promise<void>
}

export type ComputerDriverConnector = (
  process: ComputerDriverProcess
) => Promise<ComputerDriverClient>

class McpComputerDriverClient implements ComputerDriverClient {
  private readonly client: Client
  private readonly transport: StdioClientTransport

  constructor(client: Client, transport: StdioClientTransport) {
    this.client = client
    this.transport = transport
  }

  listTools(): Promise<Tool[]> {
    return this.client.listTools().then((result) => result.tools)
  }

  async callTool(
    name: string,
    args: JsonObject,
    options: ComputerDriverCallOptions = {}
  ): Promise<ComputerDriverResult> {
    return ComputerDriverResultSchema.parse(
      await this.client.callTool(
        { name, arguments: args },
        undefined,
        options.signal || options.timeout
          ? { signal: options.signal, timeout: options.timeout }
          : undefined
      )
    )
  }

  onClose(listener: () => void): void {
    this.client.onclose = listener
  }

  async close(): Promise<void> {
    await this.client.close()
    await this.transport.close()
  }
}

export async function connectMcpComputerDriver(
  process: ComputerDriverProcess
): Promise<ComputerDriverClient> {
  const client = new Client(
    { name: "mako-computer-use", version: "3.0.0" },
    { jsonSchemaValidator: driverSchemaValidator() }
  )
  const transport = new StdioClientTransport({ ...process, stderr: "pipe" })
  try {
    await client.connect(transport)
    return new McpComputerDriverClient(client, transport)
  } catch (error) {
    await client.close()
    await transport.close()
    throw error
  }
}
