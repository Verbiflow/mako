#!/usr/bin/env node
import { parseArgs } from "node:util"
import { MakoClient, type StartOptions } from "./client.js"
import type { ConversationChange } from "./conversation.js"
import { cloudThread, localHost } from "./transport.js"

const HELP = `mako: a conversation with any harness, from a terminal, on this computer's Mako or a cloud Thread.

  mako start <harness> [message] [--cwd <folder>] [--model <id>] [--detach]
  mako send <conversation> <message> [--detach]
  mako steer <conversation> <message>       into the running turn, where the harness takes one
  mako watch <conversation> [--history]     as it goes, until stopped
  mako questions <conversation>             what it's waiting on, with each answer's id
  mako answer <conversation> <question> <option> [--feedback <words>]
  mako refuse <conversation> <question> [--feedback <words>]
  mako stop <conversation>
  mako history <conversation>

  --json            each change as a line of JSON, for scripts
  --socket <path>   another host on this computer (default: Mako's, or MAKO_PROFILE's)
  --gateway <url> --thread <id>   a cloud Thread directly, as MAKO_DEVICE with MAKO_TOKEN's connection token

A conversation on a cloud Thread works through this computer's Mako as it works in the app.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: "string" },
    model: { type: "string" },
    detach: { type: "boolean" },
    history: { type: "boolean" },
    json: { type: "boolean" },
    feedback: { type: "string" },
    socket: { type: "string" },
    gateway: { type: "string" },
    thread: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
})

const [command, ...rest] = positionals
const json = values.json === true
const color = !json && process.stdout.isTTY
const dim = (text: string) => (color ? `\u001b[2m${text}\u001b[22m` : text)
const bold = (text: string) => (color ? `\u001b[1m${text}\u001b[22m` : text)

function transport() {
  if (values.gateway) {
    const token = process.env.MAKO_TOKEN
    const deviceId = process.env.MAKO_DEVICE
    if (!values.thread || !token || !deviceId) fail("--gateway needs --thread, MAKO_TOKEN and MAKO_DEVICE")
    return cloudThread({ gateway: values.gateway, threadId: values.thread, deviceId, token: async () => token })
  }
  return localHost(values.socket ? { socket: values.socket } : {})
}

function fail(message: string): never {
  process.stderr.write(`mako: ${message}\n`)
  process.exit(2)
}

/** Prints a change as it comes: text as it streams, a tool as a line, a question with its answers. */
let streaming: string | undefined
function print(change: ConversationChange): void {
  if (json) return void process.stdout.write(`${JSON.stringify(change)}\n`)
  const endLine = () => {
    if (streaming) process.stdout.write("\n")
    streaming = undefined
  }
  switch (change.kind) {
    case "text":
      if (streaming !== change.block) endLine()
      streaming = change.block
      return void process.stdout.write(change.text)
    case "thinking":
      if (streaming !== change.block) endLine()
      streaming = change.block
      return void process.stdout.write(dim(change.text))
    case "tool":
      endLine()
      return void process.stdout.write(`${change.state === "started" ? dim("▸") : change.state === "done" ? "✓" : "✗"} ${change.state === "started" ? dim(change.title) : change.title}\n`)
    case "user":
      endLine()
      return void process.stdout.write(`${bold("›")} ${change.text}\n`)
    case "event":
      endLine()
      return void process.stdout.write(dim(`· ${change.label}${change.detail ? ` ${change.detail}` : ""}\n`))
    case "question": {
      endLine()
      const { permission } = change
      process.stdout.write(`${bold("?")} ${permission.title}${permission.detail ? `\n  ${permission.detail}` : ""}\n`)
      for (const option of permission.options) process.stdout.write(`  ${option.name} ${dim(`(${option.optionId})`)}\n`)
      return void process.stdout.write(dim(`  question ${permission.id}: mako answer <conversation> ${permission.id} <option>\n`))
    }
    case "request":
      if (change.request.status === "failed" || change.request.status === "uncertain" || change.request.status === "interrupted") {
        endLine()
        process.stdout.write(`${bold("!")} ${change.request.status}${change.request.error ? `: ${change.request.error}` : ""}\n`)
      }
      return
    case "reread":
      return
  }
}

async function main(): Promise<void> {
  if (!command || values.help) return void process.stdout.write(`${HELP}\n`)
  const client = new MakoClient(transport())
  try {
    switch (command) {
      case "start": {
        const [harness, ...words] = rest
        if (!harness) fail("start needs a harness: claude, codex, cursor, grok, devin or opencode")
        const text = words.join(" ")
        const options: StartOptions = { harness, cwd: values.cwd ?? process.cwd() }
        if (text) options.text = text
        if (values.model) options.model = values.model
        const started = await client.start(options)
        if (json) process.stdout.write(`${JSON.stringify({ kind: "started", ...started })}\n`)
        else process.stderr.write(dim(`conversation ${started.conversationId}\n`))
        if (started.requestId && !values.detach) await settle(client, started.conversationId, started.requestId)
        return
      }
      case "send": {
        const [conversation, ...words] = rest
        if (!conversation || !words.length) fail("send needs a conversation and a message")
        const { requestId } = await client.send(conversation, words.join(" "), values.model)
        if (json) process.stdout.write(`${JSON.stringify({ kind: "sent", requestId })}\n`)
        if (!values.detach) await settle(client, conversation, requestId)
        return
      }
      case "steer": {
        const [conversation, ...words] = rest
        if (!conversation || !words.length) fail("steer needs a conversation and a message")
        const snapshot = await client.snapshot(conversation)
        const running = snapshot.requests.find((request) => request.status === "dispatching")
        if (!running) fail("nothing is running in that conversation to steer; send it instead")
        const answer = await client.steer(conversation, running.id, words.join(" "))
        return void process.stdout.write(`${JSON.stringify(answer)}\n`)
      }
      case "watch": {
        const [conversation] = rest
        if (!conversation) fail("watch needs a conversation")
        await client.watch(conversation, print)
        return
      }
      case "history": {
        const [conversation] = rest
        if (!conversation) fail("history needs a conversation")
        const snapshot = await client.snapshot(conversation)
        const { ConversationView } = await import("./conversation.js")
        for (const change of new ConversationView(conversation, snapshot).history()) print(change)
        if (streaming) process.stdout.write("\n")
        // For a script: each request and where it ended.
        if (json) for (const request of snapshot.requests) process.stdout.write(`${JSON.stringify({ kind: "request", id: request.id, status: request.status })}\n`)
        return
      }
      case "questions": {
        const [conversation] = rest
        if (!conversation) fail("questions needs a conversation")
        const snapshot = await client.snapshot(conversation)
        for (const permission of snapshot.permissions) print({ kind: "question", permission })
        return
      }
      case "answer":
      case "refuse": {
        const [conversation, question, option] = rest
        if (!conversation || !question || (command === "answer" && !option)) fail(`${command} needs a conversation, a question${command === "answer" ? " and an option" : ""}`)
        await client.answer(conversation, question, command === "refuse" ? null : (option ?? null), values.feedback)
        return
      }
      case "stop": {
        const [conversation] = rest
        if (!conversation) fail("stop needs a conversation")
        await client.stop(conversation)
        return
      }
      default:
        fail(`no command ${command}; mako --help lists them`)
    }
  } finally {
    client.close()
  }
}

/** Watches a request's turn to its end, printing it; exits non-zero when the turn didn't complete. */
async function settle(client: MakoClient, conversationId: string, requestId: string): Promise<void> {
  const request = await client.turn(conversationId, requestId, print)
  if (streaming) process.stdout.write("\n")
  if (json) process.stdout.write(`${JSON.stringify({ kind: "settled", requestId, status: request?.status ?? "unknown" })}\n`)
  if (request?.status !== "completed") process.exitCode = 1
}

main().catch((error: Error) => fail(error.message))
