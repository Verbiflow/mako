import { randomUUID } from "node:crypto"
import { parseArgs } from "node:util"
import type { AgentCaller } from "@mako/host/contracts/agents"
import { SESSION_VARIABLE } from "@mako/host/contracts/agent-tools"
import { THREAD_MOVE_TOOL, type ThreadsMoveInput } from "@mako/host/contracts/thread-tools"
import { ThreadMoveAnswerSchema, threadToolText } from "@mako/host/conversations/thread-move-tool"
import { localHost } from "./transport.js"

export const THREAD_HELP = `  mako thread move cloud|back [--conversation <id>] [--key <k>]
                    cloud: Move to the cloud, or Continue in the cloud for another device's Thread while it's off.
                    back: Bring it back to this Mac. From a Thread's shell (${SESSION_VARIABLE}) it moves that Thread,
                    as thread_move does; from your own shell, name the conversation, and it waits for the move's end.`

const OPTIONS = {
  conversation: { type: "string" },
  key: { type: "string" },
  socket: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const

function caller(): AgentCaller {
  const session = process.env[SESSION_VARIABLE]
  return session ? { kind: "agent", session } : { kind: "person" }
}

/** `mako thread move <to>`'s input, from its arguments. */
export function threadMoveInput(argv: string[]): ThreadsMoveInput {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })
  const [command, verb, to] = positionals
  if (command !== "thread" || verb !== "move") throw new Error("thread needs a command: move")
  if (to !== "cloud" && to !== "back") throw new Error("thread move needs where: cloud or back")
  return { to, clientKey: values.key ?? randomUUID(), ...(values.conversation && { conversation: values.conversation }) }
}

/** `mako thread move`: the same host call as the in-Thread `thread_move`. A refusal exits 1. */
export async function threadMain(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })
  if (values.help) return void process.stdout.write(`${THREAD_HELP}\n`)
  const input = threadMoveInput(argv)
  const transport = localHost(values.socket ? { socket: values.socket } : {})
  try {
    const result = ThreadMoveAnswerSchema.parse(await transport.call(THREAD_MOVE_TOOL.channel, [caller(), input]))
    process.stdout.write(`${values.json ? JSON.stringify(result) : threadToolText(result)}\n`)
    if (result.refused !== undefined) process.exitCode = 1
  } finally {
    transport.close()
  }
}
