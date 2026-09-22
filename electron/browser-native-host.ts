import {
  singleBrowserProfile,
  browserProfileName,
} from "./browser-profile-name.js"
import { z } from "zod"
import type { IncomingMessage } from "node:http"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, chmod, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"
import {
  ExtensionCommandSchema,
  ExtensionRegistrationSchema,
  ExtensionMessageSchema,
  NativeMessageDecoder,
  type ExtensionHostMessage,
  type ExtensionMessage,
} from "./browser-extension-protocol.js"

interface BrowserClient {
  socket: WebSocket
  pending: Set<number>
}

/** Chrome launches this through Native Messaging. It never opens a Chrome debugging socket. */
export async function startBrowserNativeHost(
  root: string,
  input: Readable,
  output: Writable
) {
  const clients = new Map<string, BrowserClient>()
  const decoder = new NativeMessageDecoder(32 * 1024 * 1024)
  let server: WebSocketServer | undefined
  let registration: string | undefined
  let endpoint: string | undefined
  let stopping = false
  let greeted = false
  let updateProfile: ((name: string) => Promise<void>) | undefined
  let profileUpdates: Promise<void> = Promise.resolve()
  let resolveHello: (
    hello: Extract<ExtensionMessage, { kind: "hello" }>
  ) => void = () => {}
  let rejectHello: (error: Error) => void = () => {}
  const hello = new Promise<Extract<ExtensionMessage, { kind: "hello" }>>(
    (resolve, reject) => {
      resolveHello = resolve
      rejectHello = reject
    }
  )
  const greetingTimeout = setTimeout(
    () =>
      rejectHello(new Error("Browser extension did not identify its profile")),
    5000
  )

  function send(message: ExtensionHostMessage): void {
    if (stopping) return
    const body = Buffer.from(JSON.stringify(message))
    if (
      body.byteLength > 1024 * 1024 ||
      output.writableLength > 2 * 1024 * 1024
    ) {
      void close()
      return
    }
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.byteLength)
    output.write(header)
    output.write(body)
  }

  async function close(): Promise<void> {
    if (stopping) return
    stopping = true
    clearTimeout(greetingTimeout)
    rejectHello(new Error("Browser extension disconnected"))
    for (const client of clients.values()) client.socket.terminate()
    clients.clear()
    server?.close()
    await profileUpdates
    if (registration) {
      const value = await readFile(registration, "utf8").catch(() => "")
      if (endpoint && value.includes(endpoint))
        await rm(registration, { force: true })
    }
  }

  input.on("data", (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) {
        const message = ExtensionMessageSchema.parse(JSON.parse(frame))
        if (message.kind === "hello") {
          if (greeted) throw new Error("Duplicate browser registration")
          greeted = true
          resolveHello(message)
          continue
        }
        if (!greeted) throw new Error("Missing browser registration")
        if (message.kind === "profile-name") {
          profileUpdates = profileUpdates
            .then(async () => {
              if (!stopping) await updateProfile?.(message.profileName)
            })
            .catch(() => {
              void close()
            })
          continue
        }
        const client = clients.get(message.client)
        if (!client) continue
        if (client.socket.bufferedAmount > 32 * 1024 * 1024) {
          client.socket.terminate()
          continue
        }
        if (message.kind === "event") {
          client.socket.send(
            JSON.stringify({
              sessionId: message.sessionId,
              method: message.method,
              params: message.params,
            })
          )
        } else if (client.pending.delete(message.id)) {
          client.socket.send(
            JSON.stringify(
              message.kind === "response"
                ? { id: message.id, result: message.result }
                : {
                    id: message.id,
                    error: { code: -32000, message: message.message },
                  }
            )
          )
        }
      }
    } catch {
      void close()
    }
  })
  input.once("end", () => void close())
  input.once("error", () => void close())
  output.once("error", () => void close())

  try {
    const profile = await hello
    clearTimeout(greetingTimeout)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await chmod(root, 0o700)
    if (stopping) throw new Error("Browser extension disconnected")
    const secret = randomBytes(32).toString("base64url")
    server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
      verifyClient: ({ req }: { req: IncomingMessage }) =>
        !req.headers.origin &&
        req.url === `/mako-browser/${secret}` &&
        clients.size < 16,
    })
    server.on("connection", (socket) => {
      const client = randomUUID()
      const pending = new Set<number>()
      clients.set(client, { socket, pending })
      socket.on("message", (data) => {
        try {
          const command = ExtensionCommandSchema.parse(
            JSON.parse(data.toString())
          )
          if (pending.size >= 128 || pending.has(command.id))
            throw new Error("Browser client request limit exceeded")
          pending.add(command.id)
          send({ kind: "request", client, command })
        } catch {
          socket.terminate()
        }
      })
      socket.on("error", () => socket.terminate())
      socket.once("close", () => {
        clients.delete(client)
        send({ kind: "disconnect", client })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server?.once("listening", resolve)
      server?.once("error", reject)
    })
    const address = z
      .object({ port: z.number().int().positive() })
      .parse(server.address())
    endpoint = `ws://127.0.0.1:${address.port}/mako-browser/${secret}`
    const id = `${profile.family}:${profile.profileId}`
    const product = z
      .string()
      .min(1)
      .max(80)
      .safeParse(process.env.MAKO_BROWSER_PRODUCT)
    const browserProduct = product.success ? product.data : profile.product
    const profileDirectory = process.env.MAKO_BROWSER_ROOT
      ? await singleBrowserProfile(process.env.MAKO_BROWSER_ROOT)
      : undefined
    const profileName =
      profile.profileName ??
      (profileDirectory
        ? await browserProfileName(profileDirectory)
        : undefined)
    const name = (
      profileName ? `${browserProduct} · ${profileName}` : browserProduct
    ).slice(0, 100)
    registration = join(root, `${profile.family}-${profile.profileId}.json`)
    const temporary = `${registration}.${process.pid}.tmp`
    await writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        product: browserProduct,
        profileDirectory: profile.profileName ? undefined : profileDirectory,
        profileName,
        id,
        name,
        endpoint,
        pid: process.pid,
      }),
      { mode: 0o600, flag: "wx" }
    )
    await rename(temporary, registration)
    if (stopping) throw new Error("Browser extension disconnected")
    const registrationPath = registration
    updateProfile = async (profileName) => {
      const metadata = ExtensionRegistrationSchema.parse(
        JSON.parse(await readFile(registrationPath, "utf8"))
      )
      const temporary = `${registrationPath}.${randomUUID()}.tmp`
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            ...metadata,
            profileName,
            profileDirectory: undefined,
            name: `${browserProduct} · ${profileName}`.slice(0, 100),
          }),
          { mode: 0o600, flag: "wx" }
        )
        await rename(temporary, registrationPath)
        send({ kind: "ready", profileName })
      } finally {
        await rm(temporary, { force: true })
      }
    }
    send({ kind: "ready", profileName })
    return { close, registration }
  } catch (error) {
    await close()
    throw error
  }
}
