import { randomUUID } from "node:crypto"
import { parseArgs } from "node:util"
import type { AgentCaller } from "@mako/host/contracts/agents"
import { SESSION_VARIABLE } from "@mako/host/contracts/agent-tools"
import { AUTOMATION_TOOL, HARNESS_TOOL, SETTINGS_TOOL, THREAD_ACT_TOOL, THREAD_MOVE_TOOL, type AutomationActInput, type HarnessActInput, type SettingsInput, type ThreadActInput, type ThreadsMoveInput } from "@mako/host/contracts/thread-tools"
import { ThreadMoveAnswerSchema, threadToolText } from "@mako/host/conversations/thread-move-tool"
import { localHost } from "./transport.js"

export const THREAD_HELP = `  mako thread move cloud|back [--conversation <id>] [--key <k>]
                    cloud: Move to the cloud, or Continue in the cloud for another device's Thread while it's off.
                    back: Bring it back to this Mac. From a Thread's shell (${SESSION_VARIABLE}) it moves that Thread,
                    as thread_move does; from your own shell, name the conversation, and it waits for the move's end.
  mako thread rename <title> | archive | restore [--conversation <id>] [--key <k>]
                    Rename, Archive and Restore on the Thread's menu, as the thread tool does.
  mako settings read | set <setting> <value>
                    What the settings tool reads and changes: hand-off-on-sleep, continue-after-restart, harness-order
                    (harnesses first to last, comma-separated), commit-model, keep-awake and keep-awake-lid-closed.
  mako harness read | install <harness> | update <harness>
                    Install and Update in Settings › Harnesses, as the harness tool does.
  mako automation list | run <id> | on <id> | off <id>
                    Settings › Automations, as the automation tool does.`

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
  const [, , to] = positionals
  if (to !== "cloud" && to !== "back") throw new Error("thread move needs where: cloud or back")
  return { to, clientKey: values.key ?? randomUUID(), ...(values.conversation && { conversation: values.conversation }) }
}

/** `mako thread rename|archive|restore`'s input, from its arguments. */
export function threadActInput(argv: string[]): ThreadActInput {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })
  const [, action, ...title] = positionals
  if (action !== "rename" && action !== "archive" && action !== "restore") throw new Error("thread needs a command: move, rename, archive or restore")
  return { action, clientKey: values.key ?? randomUUID(), ...(title.length && { title: title.join(" ") }), ...(values.conversation && { conversation: values.conversation }) }
}

/** `mako settings read|set`'s input, from its arguments. */
export function settingsInput(argv: string[]): SettingsInput {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })
  const [, action, setting, value] = positionals
  const key = values.key ?? randomUUID()
  if (action === "read") return { action, clientKey: key }
  if (action !== "set" || !setting || value === undefined) throw new Error("settings needs read, or set <setting> <value>")
  const parsed = value === "true" ? true : value === "false" ? false : setting === "harness-order" ? value.split(",") : value
  return { action, setting, value: parsed, clientKey: key }
}

/** `mako harness read|install|update`'s input, from its arguments. */
export function harnessInput(argv: string[]): HarnessActInput {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })
  const [, action, harness] = positionals
  if (action !== "read" && action !== "install" && action !== "update") throw new Error("harness needs read, install <harness> or update <harness>")
  return { action, clientKey: values.key ?? randomUUID(), ...(harness && { harness }) }
}

/** `mako automation list|run|on|off`'s input, from its arguments. */
export function automationInput(argv: string[]): AutomationActInput {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })
  const [, action, id] = positionals
  if (action !== "list" && action !== "run" && action !== "on" && action !== "off") throw new Error("automation needs list, run <id>, on <id> or off <id>")
  return { action, clientKey: values.key ?? randomUUID(), ...(id && { id }) }
}

/** `mako settings`, `mako harness` and `mako automation`: the same host calls as the in-Thread `settings`, `harness` and `automation`. A refusal exits 1. */
export async function settingsMain(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })
  if (values.help) return void process.stdout.write(`${THREAD_HELP}\n`)
  const [tool, input] = positionals[0] === "harness" ? [HARNESS_TOOL, harnessInput(argv)] : positionals[0] === "automation" ? [AUTOMATION_TOOL, automationInput(argv)] : [SETTINGS_TOOL, settingsInput(argv)]
  const transport = localHost(values.socket ? { socket: values.socket } : {})
  try {
    const result = ThreadMoveAnswerSchema.parse(await transport.call(tool.channel, [caller(), input]))
    process.stdout.write(`${values.json ? JSON.stringify(result) : threadToolText(result)}\n`)
    if (result.refused !== undefined) process.exitCode = 1
  } finally {
    transport.close()
  }
}

/** `mako thread`: the same host calls as the in-Thread `thread_move` and `thread`. A refusal exits 1. */
export async function threadMain(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })
  if (values.help) return void process.stdout.write(`${THREAD_HELP}\n`)
  const [tool, input] = positionals[1] === "move" ? [THREAD_MOVE_TOOL, threadMoveInput(argv)] : [THREAD_ACT_TOOL, threadActInput(argv)]
  const transport = localHost(values.socket ? { socket: values.socket } : {})
  try {
    const result = ThreadMoveAnswerSchema.parse(await transport.call(tool.channel, [caller(), input]))
    process.stdout.write(`${values.json ? JSON.stringify(result) : threadToolText(result)}\n`)
    if (result.refused !== undefined) process.exitCode = 1
  } finally {
    transport.close()
  }
}
