import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Json } from "@mako/protocol"
import { z } from "zod"
import { hostCallSchema } from "../../contracts/host-call-inputs.js"
import { setupStep, type SimulatorSetup } from "../../contracts/simulator-setup.js"
import { SIMULATOR_TOOLS, type SimulatorAgent, type SimulatorToolDefinition } from "../../contracts/simulators.js"
import { iosAvailability } from "./local-host.js"
import { consentFor } from "./simulators.js"

/** What a Thread's `mako` server calls the host through, as a client would, and who it calls as. */
export interface SimulatorToolDoor {
  invoke(channel: SimulatorToolDefinition["channel"], args: Json[]): Promise<Json | undefined>
  /** The agent calling, by its Session alone (`via` is the host's to stamp); none for a server no Thread's Session holds. */
  caller(): { kind: "agent"; session: string } | undefined
}

/** A tool's MCP input: its host call's generated input, each field described for the model. */
export function simulatorToolSchema(tool: SimulatorToolDefinition): z.ZodType {
  const input = hostCallSchema(tool.channel).def.items[1]
  if (input === undefined) return z.object({})
  if (!(input instanceof z.ZodObject)) throw new Error(`${tool.channel}'s input isn't an object`)
  const generated = z.toJSONSchema(input, { io: "input" })
  const properties = Object.entries(generated.properties ?? {}).map(([field, schema]): [string, z.core.JSONSchema._JSONSchema] => {
    const description = tool.mcp.fields[field]
    return [field, description && schema !== true && schema !== false ? { ...schema, description } : schema]
  })
  return z.fromJSONSchema({ ...generated, properties: Object.fromEntries(properties) })
}

/** What a tool says back: the host's answer as JSON, a refusal's reason on its first line. */
export function simulatorToolText(answer: Json | undefined): string {
  const json = JSON.stringify(answer, null, 2)
  const refused = z.object({ refused: z.string() }).safeParse(answer)
  return refused.success ? `refused: ${refused.data.refused}\n${json}` : json
}

/**
 * The simulator tools on a Thread's `mako` server: offered only once this Mac can run a simulator and the person has
 * let agents use simulators in the Thread's project, so an agent never sees a tool that can only refuse it. The
 * server is made for each request, so what's offered follows the setup line as it changes.
 */
export class SimulatorTools {
  readonly #agent: (session: string) => SimulatorAgent | undefined
  readonly #borrowed: boolean
  #setup: SimulatorSetup | undefined

  /**
   * `agent`: what the host knows of a Session, as `Simulators` reads it, so consent is read the same way. `borrowed`: a
   * cloud Thread's machine, whose simulators are a Mac of the person's borrowed under a lease, so its own setup line
   * (no macOS here) doesn't decide whether its agents have the tools; the person's grant does, at each call.
   */
  constructor(agent: (session: string) => SimulatorAgent | undefined, borrowed = false) {
    this.#agent = agent
    this.#borrowed = borrowed
  }

  heard(setup: SimulatorSetup): void {
    this.#setup = setup
  }

  offered(session: string | undefined): boolean {
    const agent = session === undefined ? undefined : this.#agent(session)
    if (agent && this.#borrowed) return true
    if (!agent || !this.#setup || !iosAvailability(this.#setup).ready) return false
    return consentFor(setupStep(this.#setup, "agents")?.projects ?? [], agent) === "allowed"
  }

  register(server: McpServer, door: SimulatorToolDoor): void {
    if (!this.#borrowed && (!this.#setup || !iosAvailability(this.#setup).ready)) return
    // A server built as its agent launches (Claude's in-process one) has no turn yet to name its Thread by: its tools
    // are offered, and `Simulators` decides each call by the project's consent.
    let caller: ReturnType<SimulatorToolDoor["caller"]> | "not yet"
    try {
      caller = door.caller()
    } catch {
      caller = "not yet"
    }
    if (caller !== "not yet" && !this.offered(caller?.session)) return
    for (const tool of SIMULATOR_TOOLS) {
      server.registerTool(tool.mcp.name, { description: tool.mcp.description, inputSchema: simulatorToolSchema(tool), annotations: tool.mcp.annotations }, async (input) => {
        try {
          const caller = door.caller()
          if (!caller) throw new Error("This server's Thread has ended.")
          // The SDK checked the input against the tool's schema, which is JSON's.
          const answer = await door.invoke(tool.channel, tool.verb === "list" ? [caller] : [caller, z.json().parse(input)])
          const refused = z.object({ refused: z.string() }).safeParse(answer).success
          return { ...(refused && { isError: true }), content: [{ type: "text" as const, text: simulatorToolText(answer) }] }
        } catch (error) {
          return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }
        }
      })
    }
  }
}
