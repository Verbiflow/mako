import assert from "node:assert/strict"
import { createServer, type AddressInfo, type Socket } from "node:net"
import { test } from "node:test"
import { problemType, SshRefusedError, type SshStream } from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { followHostLog, type HostLogLine } from "@mako/host/base/host-log"
import { serveHostThroughGateway } from "@mako/host/transport/gateway"
import { SshRelay } from "@mako/host/transport/ssh-relay"

const client = { kind: "client", client: "desktop", deviceId: "d-ssh-test" } as const

/** A server on the loopback standing in for the machine's SSH server: `serve` gets each connection. */
async function server(serve: (socket: Socket) => void) {
  const sockets = new Set<Socket>()
  const listening = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    serve(socket)
  })
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve))
  // SAFETY: a server listening on a TCP port is addressed by an AddressInfo.
  const port = (listening.address() as AddressInfo).port
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        listening.close(() => resolve())
      }),
  }
}

/** A runtime on the fake gateway running th-1 with the host's SSH relay to `port`, and a client of it. */
async function relayed(port: number | undefined) {
  const gateway = createFakeGateway()
  const runtime = await serveHostThroughGateway(await gateway.connectRuntime(), {
    runtimeId: "machine",
    build: "test",
    invoke: async () => assert.fail("SSH makes no host calls"),
    ssh: new SshRelay({ port: () => port }),
  })
  await gateway.assign("th-1", "machine")
  while (runtime.generation("th-1") === undefined) await new Promise((resolve) => setImmediate(resolve))
  const session = await gateway.connectClient(client)
  return {
    session,
    close: async () => {
      runtime.close()
      await runtime.done
      await gateway.close()
    },
  }
}

/** Reads `bytes` of the server's bytes, taking each as it comes, as `mako ssh --stdio` writes them out. */
async function reads(ssh: SshStream, bytes: number): Promise<Buffer> {
  const pieces: Buffer[] = []
  let read = 0
  while (read < bytes) {
    const delivery = await ssh.next(5_000)
    if (delivery.kind !== "data") assert.fail(`ended after ${read} bytes: ${JSON.stringify(delivery.problem)}`)
    pieces.push(Buffer.from(delivery.data))
    read += delivery.data.byteLength
    ssh.took(delivery.data.byteLength)
  }
  return Buffer.concat(pieces)
}

test("a client's stream reaches the machine's server on the loopback, and each side's bytes cross whole, paced, past a window", async () => {
  const echo = await server((socket) => {
    socket.write("SSH-2.0-OpenSSH_9.6\r\n")
    socket.pipe(socket)
  })
  const { session, close } = await relayed(echo.port)
  const ssh = session.ssh({ threadId: "th-1", stream: "ssh-stream-1" })
  await ssh.opened
  assert.equal((await reads(ssh, 21)).toString(), "SSH-2.0-OpenSSH_9.6\r\n")
  // Three windows each way: neither side gets further than a window ahead of the other's taking.
  const up = Buffer.alloc(3 * 1024 * 1024 + 17).map((_, index) => index % 251)
  ssh.send(up)
  assert.ok((await reads(ssh, up.byteLength)).equals(up))
  await ssh.drained()
  ssh.close()
  await close()
  await echo.close()
})

test("the server closing ends the stream for the client once what it said last arrived, and both ends are logged as one", async () => {
  const logged: HostLogLine[] = []
  const unfollow = followHostLog((line) => logged.push(line))
  const banner = await server((socket) => socket.end("SSH-2.0-OpenSSH_9.6\r\nbye"))
  const { session, close } = await relayed(banner.port)
  const ssh = session.ssh({ threadId: "th-1", stream: "ssh-stream-2" })
  await ssh.opened
  assert.equal((await reads(ssh, 24)).toString(), "SSH-2.0-OpenSSH_9.6\r\nbye")
  assert.deepEqual(await ssh.next(5_000), { kind: "ended" })
  unfollow()
  const [opened, ended] = [logged.find((line) => line.message === "an SSH stream opened"), logged.find((line) => line.message === "an SSH stream ended")]
  assert.ok(opened?.fields?.correlationId, "the open is logged with its correlation ID")
  assert.equal(ended?.fields?.correlationId, opened.fields.correlationId)
  assert.deepEqual([ended.fields.stream, ended.fields.threadId, ended.fields.down, ended.fields.why], ["ssh-stream-2", "th-1", 24, "the server closed it"])
  await close()
  await banner.close()
})

test("the client leaving closes its connection to the server", async () => {
  let closed: () => void = () => undefined
  const gone = new Promise<void>((resolve) => (closed = resolve))
  const quiet = await server((socket) => socket.on("close", closed))
  const { session, close } = await relayed(quiet.port)
  const ssh = session.ssh({ threadId: "th-1", stream: "ssh-stream-3" })
  await ssh.opened
  ssh.close()
  await gone
  await close()
  await quiet.close()
})

test("a machine whose agent named no server, or whose server isn't running, refuses the stream and says why", async () => {
  const none = await relayed(undefined)
  const refused = none.session.ssh({ threadId: "th-1", stream: "ssh-stream-4" })
  await assert.rejects(refused.opened, (error) => error instanceof SshRefusedError && error.problem?.title === "This machine serves no SSH")
  await none.close()

  const stopped = await server(() => undefined)
  await stopped.close()
  const down = await relayed(stopped.port)
  const ssh = down.session.ssh({ threadId: "th-1", stream: "ssh-stream-5" })
  await assert.rejects(
    ssh.opened,
    (error) => error instanceof SshRefusedError && error.problem !== undefined && problemType(error.problem) === "unavailable" && error.problem.title === "The machine's SSH server isn't running"
  )
  await down.close()
})
