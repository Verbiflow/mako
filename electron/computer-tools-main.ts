import { serveControlSession } from "./control-session-server.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { parseArgs } from "node:util"
import { randomUUID } from "node:crypto"
import { isMainModule } from "./main-module.js"
import { controlFaultData } from "@mako/control/control"
import {
  ControlProgramInputSchema,
  PROGRAM_TIME_LIMIT_MS,
  INLINE_TEXT_BUDGET,
} from "@mako/control/program"
import {
  connectMcpComputerDriver,
  type ComputerDriverConnector,
} from "./computer-driver-client.js"
import {
  createControlSession,
  COMPUTER_TOOL_INPUTS,
  controlHelpInputSchema,
  type ComputerBackend,
  type ControlSessionOptions,
} from "./control-session.js"
export { COMPUTER_TOOL_INPUTS } from "./control-session.js"
export { BACKGROUND_INPUT_LADDER } from "@mako/control/computer"

export function createComputerToolsServer(
  backend?: ComputerBackend,
  taskId = process.env.MAKO_TASK_ID ?? randomUUID(),
  connectDriver: ComputerDriverConnector = connectMcpComputerDriver,
  options: ControlSessionOptions & { cli?: boolean } = {}
): Server {
  const session = createControlSession(backend, taskId, connectDriver, options)
  let shell: ReturnType<typeof serveControlSession> | undefined
  const shellSession = () => (shell ??= serveControlSession(session))
  const unified = options.surface !== "driver"
  const toolPrefix = unified ? "mako_control" : "mako_computer"
  class ComputerServer extends Server {
    private finishing: Promise<void> | undefined
    override close(): Promise<void> {
      return (this.finishing ??= (async () => {
        try {
          if (shell) await (await shell).close()
        } finally {
          try {
            await session.close()
          } finally {
            await super.close()
          }
        }
      })())
    }
  }
  const statusTool = `${toolPrefix}_status`
  const helpTool = `${toolPrefix}_help`
  const execTool = `${toolPrefix}_exec`
  const server = new ComputerServer(
    {
      name: unified ? "mako-control" : "mako-driver-test-runtime",
      version: "4.0.0",
    },
    {
      capabilities: { tools: {} },
      instructions: session.instructions,
    }
  )
  server.onclose = () => {
    void server.close()
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: statusTool,
        description: unified
          ? "Report the routes available to this provider-neutral Mako control client, including page control, native control and the bounded native guard. Does not request OS permission."
          : "Report whether this MCP client is attached to Mako's native computer-control driver, the input routing policy, and where oversized results are written. Does not request OS permission.",
        inputSchema: z.toJSONSchema(COMPUTER_TOOL_INPUTS.status, {
          io: "input",
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: helpTool,
        description: unified
          ? "Reference for Local Control v2 bound handles, explicit observations, assertions and escape hatches. With domain and optional method, returns the pinned CDP schema."
          : "Reference for the computer program API, read from the live driver. With no arguments, lists every computer.<action> signature and the background input ladder. With tool, returns that action's full input and output schema, its description and Mako's notes.",
        inputSchema: z.toJSONSchema(
          unified ? controlHelpInputSchema : COMPUTER_TOOL_INPUTS.help,
          {
            io: "input",
          }
        ),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: execTool,
        description: unified
          ? `Run Local Control v2 with {"source":"return await control.browsers()"}. To collect a running program, copy its numeric cell into {"cell":1}; supply exactly one field. Use bound window/tab handles, explicit observe/expect, state for cross-cell handles, return/console.log for text and emitImage for screenshots. Read mako_control_help once for API signatures. ${PROGRAM_TIME_LIMIT_MS / 1000}-second hard limit; output past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB spills whole to artifacts. No actions are replayed.`
          : `Run or resume a computer control program: pass {source} with trusted async JavaScript, or {cell} when a program yields after ten seconds and continues. Read a window with view(), take and verify a step with act(), write a field with fill(), press Enter with submit(), select a proven route with route(), and guard chained steps with expect() and until(); state and bounded checkpoint/recall task memory survive cells. Await every action and return only what you need to decide. Nothing fronts the user's application without foreground: true on the call. Results are never truncated: a value past ${Math.round(INLINE_TEXT_BUDGET / 1000)} KB is written to a file and described. ${PROGRAM_TIME_LIMIT_MS / 1000}-second hard limit; every action keeps Mako's session, snapshot, path, foreground and preview checks.

checkpoint({objective?, location?, remember?: {key: value}, completed?: string[], pending?: string[]}) stores bounded task memory; remember is an object, not prose. recall() reads it.

${await session.reference()}`,
        inputSchema: ControlProgramInputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let dispatched = false
    try {
      switch (request.params.name) {
        case statusTool: {
          COMPUTER_TOOL_INPUTS.status.parse(request.params.arguments ?? {})
          const value = { ...(await session.status()) }
          const sessionFile =
            options.cli && unified ? (await shellSession()).file : undefined
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ...value, sessionFile }),
              },
            ],
          }
        }
        case helpTool: {
          const rawArgs = z
            .record(z.string(), z.json())
            .parse(request.params.arguments ?? {})
          const value = await session.help(rawArgs)
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
          }
        }
        case execTool: {
          const input = COMPUTER_TOOL_INPUTS.exec.parse(
            request.params.arguments
          )
          dispatched = true
          return { content: await session.execute(input, extra.signal) }
        }

        default:
          throw new Error(
            `Unknown tool ${request.params.name}. Control is ${statusTool}, ${helpTool} and ${execTool}; every action runs inside ${execTool}.`
          )
      }
    } catch (error) {
      const detail = {
        code:
          controlFaultData(error)?.code ??
          (dispatched ? "computer-control-error" : "invalid-request"),
        outcome:
          controlFaultData(error)?.outcome ??
          (dispatched ? "unknown" : "not-dispatched"),
        message:
          error instanceof z.ZodError
            ? `Invalid arguments for ${request.params.name}. ${z.prettifyError(error).replace(/\s+/g, " ").trim()}`
            : error instanceof Error
              ? error.message
              : "Computer operation failed",
        recovery: !dispatched
          ? request.params.name === execTool
            ? `No program was started or resumed by this call. To start, use {"source":"<async JavaScript>"}; to collect, copy the numeric cell from the running receipt, for example {"cell":1}. Correct the arguments; do not resubmit a running program's source.`
            : "Correct the tool arguments and call again; no control action was dispatched."
          : controlFaultData(error)?.code === "cell-pending" ||
              controlFaultData(error)?.code === "cell-not-found"
            ? "Follow the cell instructions in the message. Do not start another program to recover a pending result."
            : "Read the exact target again before deciding whether to repeat an action.",
      }
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(detail) }],
        structuredContent: detail,
      }
    }
  })
  return server
}

export async function startComputerToolsServer(): Promise<void> {
  const { values } = parseArgs({
    options: {
      socket: { type: "string" },
      driver: { type: "string" },
      "driver-test": { type: "boolean", default: false },
    },
  })
  const backend =
    values.socket && values.driver
      ? {
          command: values.driver,
          args: ["mcp", "--embedded", "--socket", values.socket],
          // The proxy's own telemetry, off like the daemon's (cua-embedded.ts).
          env: {
            ...getDefaultEnvironment(),
            CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
            CUA_DRIVER_REQUIRE_FOCUSED_TARGET: "1",
          },
        }
      : undefined
  const server = createComputerToolsServer(
    backend,
    undefined,
    connectMcpComputerDriver,
    {
      surface: values["driver-test"] ? "driver" : "control",
      cli: !values["driver-test"],
    }
  )
  const close = () => {
    void server.close()
  }
  process.stdin.once("end", close)
  process.once("SIGTERM", close)
  process.once("SIGINT", close)
  await server.connect(new StdioServerTransport())
}
if (isMainModule(import.meta.url))
  void startComputerToolsServer().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
