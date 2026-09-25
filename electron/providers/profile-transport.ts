import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { z } from "zod"
import type { JsonObject, JsonValue } from "../codex-app-json.js"
import { withDiscoveryProcess } from "./discovery-process.js"

export async function readJson<TResult>(path: string): Promise<TResult | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return null
  }
}

export function runDiscovery(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
  cwd?: string
): Promise<string> {
  return withDiscoveryProcess(
    { command, args, env, cwd },
    async ({ child, exited }) => {
      const chunks: Buffer[] = []
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
      child.stdin.end(input)
      const result = await exited
      if (result.code !== 0)
        throw new Error(
          `${command} discovery exited with ${result.signal ?? result.code}`
        )
      return Buffer.concat(chunks).toString("utf8")
    }
  )
}

export interface DiscoveryStream {
  request<T>(
    request: JsonObject,
    pick: (value: JsonValue) => T | undefined
  ): Promise<T>
  notify(message: JsonObject): void
  endInput(): void
}

/** One bounded process; adapters own wire methods and exact reply matching. */
export function withDiscoveryStream<TResult>(
  options: Parameters<typeof withDiscoveryProcess>[0],
  run: (stream: DiscoveryStream) => Promise<TResult>
): Promise<TResult> {
  return withDiscoveryProcess(options, async ({ child, exited, phase }) => {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    let pending:
      { accept(value: JsonValue): void; reject(error: Error): void } | undefined
    let closed: Error | undefined
    const fail = (error: Error) => {
      closed = error
      pending?.reject(error)
      pending = undefined
    }
    lines.on("line", (line) => {
      let message: JsonValue
      try {
        message = z.json().parse(JSON.parse(line))
      } catch {
        return
      }
      pending?.accept(message)
    })
    void exited.then(({ code, signal }) =>
      fail(
        new Error(
          `${options.command} exited with ${signal ?? code} before discovery completed`
        )
      )
    )
    try {
      return await run({
        request: <T>(
          request: JsonObject,
          pick: (value: JsonValue) => T | undefined
        ) => {
          if (closed) return Promise.reject(closed)
          if (pending)
            return Promise.reject(
              new Error("Discovery requests must be sequential")
            )
          return new Promise<T>((resolve, reject) => {
            pending = {
              reject,
              accept: (message) => {
                try {
                  const selected = pick(message)
                  if (selected === undefined) return
                  pending = undefined
                  resolve(selected)
                } catch {
                  pending = undefined
                  reject(
                    new Error(
                      `${options.command} returned an invalid discovery response`
                    )
                  )
                }
              },
            }
            phase("control response")
            child.stdin.write(`${JSON.stringify(request)}\n`)
          })
        },
        notify: (message) => {
          if (closed) throw closed
          child.stdin.write(`${JSON.stringify(message)}\n`)
        },
        endInput: () => child.stdin.end(),
      })
    } finally {
      fail(new Error("Discovery stream closed"))
      lines.close()
    }
  })
}

export function streamRequest<TResult>(
  command: string,
  args: string[],
  request: JsonObject,
  env: NodeJS.ProcessEnv,
  pick: (value: JsonValue) => TResult | undefined,
  cwd?: string,
  priority: Parameters<
    typeof withDiscoveryProcess
  >[0]["priority"] = "background"
): Promise<TResult> {
  return withDiscoveryStream(
    { command, args, env, cwd, priority },
    ({ request: send, endInput }) => {
      const response = send(request, pick)
      endInput()
      return response
    }
  )
}

const RpcResponseSchema = z.object({
  id: z.number(),
  result: z.json().optional(),
  error: z.object({ code: z.number().optional() }).optional(),
})

export interface DiscoveryRpc {
  request(method: string, params?: JsonObject): Promise<JsonValue>
}

export function withDiscoveryRpc<TResult>(
  options: Parameters<typeof withDiscoveryProcess>[0] & { jsonrpc: boolean },
  run: (rpc: DiscoveryRpc) => Promise<TResult>
): Promise<TResult> {
  return withDiscoveryStream(options, async (stream) => {
    let sequence = 0
    const envelope = (message: JsonObject) => {
      if (options.jsonrpc) message.jsonrpc = "2.0"
      return message
    }
    const rpc: DiscoveryRpc = {
      request: (method, params = {}) => {
        const id = ++sequence
        return stream.request(envelope({ id, method, params }), (value) => {
          const parsed = RpcResponseSchema.safeParse(value)
          if (!parsed.success || parsed.data.id !== id) return undefined
          if (parsed.data.error) throw new Error(`RPC ${method} failed`)
          if (parsed.data.result === undefined)
            throw new Error(`RPC ${method} returned no result`)
          return parsed.data.result
        })
      },
    }
    await rpc.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "mako", title: "Mako", version: "0.0.1" },
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
      capabilities: { experimentalApi: true },
    })
    // The next request carries initialized first on the same ordered pipe.
    // Notifications have no reply, so they do not occupy a request slot.
    stream.notify(envelope({ method: "initialized", params: {} }))
    return run(rpc)
  })
}

export function rpcRequest(
  command: string,
  args: string[],
  method: string,
  env: NodeJS.ProcessEnv,
  jsonrpc: boolean,
  params: JsonObject = {},
  cwd?: string
): Promise<JsonValue> {
  return withDiscoveryRpc({ command, args, env, cwd, jsonrpc }, (rpc) =>
    rpc.request(method, params)
  )
}
