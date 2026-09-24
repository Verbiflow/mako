import assert from "node:assert/strict"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { createControlDirectory } from "../packages/control-runtime/dist/desktop.js"
import {
  createControlSession,
  serveControlSession,
  readControlSession,
  requestControlSession,
} from "../packages/control-runtime/dist/session.js"

const root = await mkdtemp(join(tmpdir(), "mako-socket-check-"))
const servers = []
const sockets = []
const previous = process.env.TMPDIR
let orphan
let unrelated
let child
try {
  // Same long prefix would collide if the OS silently truncated the paths.
  const parent = join(root, "long-" + "界".repeat(35))
  await mkdir(parent)
  for (const name of ["first", "second"]) {
    const server = await serveControlSession(
      createControlSession(undefined, name),
      {
        directory: join(parent, name),
      }
    )
    servers.push(server)
    const descriptor = await readControlSession(server.file)
    sockets.push(descriptor.socket)
    assert.ok(Buffer.byteLength(descriptor.socket) <= 103)
    assert.equal((await stat(dirname(descriptor.socket))).mode & 0o777, 0o700)
    assert.equal((await stat(descriptor.socket)).mode & 0o777, 0o600)
    const reply = await requestControlSession(
      descriptor,
      { method: "exec", source: `return ${JSON.stringify(name)}` },
      new AbortController().signal
    )
    assert.equal(reply.ok, true)
    assert.equal(JSON.parse(reply.value.at(-1).text), name)
  }
  assert.notEqual(sockets[0], sockets[1])
  process.env.TMPDIR = parent
  const runtime = await createControlDirectory("mako-cloud-")
  assert.ok(Buffer.byteLength(join(runtime, "session/session.sock")) <= 103)
  assert.equal((await stat(runtime)).mode & 0o777, 0o700)
  await rm(runtime, { recursive: true })
  // A dead owner can leave a socket. A later process reaps only its empty
  // socket directory, preserving live owners and directories with other data.
  const module = new URL(
    "../packages/control-runtime/dist/private-socket.js",
    import.meta.url
  ).href
  child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {createPrivateControlSocket} from ${JSON.stringify(module)};
    import {createServer} from 'node:net';
    const endpoint=await createPrivateControlSocket(${JSON.stringify(parent)},'child.sock');
    process.umask(0o077);
    createServer(connection=>connection.end()).listen(endpoint.path,()=>console.log(endpoint.path));
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
  const socket = await new Promise((resolve, reject) => {
    let text = ""
    child.stdout.on("data", (bytes) => {
      text += bytes
      if (text.includes("\n")) resolve(text.trim())
    })
    child.once("error", reject)
    child.once("exit", () =>
      reject(new Error("Socket fixture exited before listening"))
    )
  })
  orphan = dirname(socket)
  const exited = new Promise((resolve) => child.once("exit", resolve))
  child.kill("SIGKILL")
  await exited
  unrelated = join("/tmp", `mako-socket-${child.pid}-unsafe`)
  await mkdir(unrelated, { mode: 0o700 })
  await writeFile(join(unrelated, "keep.txt"), "untouched")
  await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import {createPrivateControlSocket} from ${JSON.stringify(module)};
    const endpoint=await createPrivateControlSocket(${JSON.stringify(parent)},'next.sock');
    await endpoint.close();
    await new Promise(resolve=>setTimeout(resolve,150));
  `,
  ])
  await assert.rejects(access(orphan))
  assert.equal(await readFile(join(unrelated, "keep.txt"), "utf8"), "untouched")
  for (const server of servers) {
    const descriptor = await readControlSession(server.file)
    const reply = await requestControlSession(
      descriptor,
      { method: "status" },
      new AbortController().signal
    )
    assert.equal(reply.ok, true, "Live sessions survive orphan cleanup")
  }
} finally {
  child?.kill()
  if (previous === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previous
  for (const server of servers) {
    await server.close()
    await server.close()
  }
  await rm(root, { recursive: true, force: true })
  if (orphan) await rm(orphan, { recursive: true, force: true })
  if (unrelated) await rm(unrelated, { recursive: true, force: true })
}
for (const socket of sockets) {
  await assert.rejects(access(socket))
  await assert.rejects(access(dirname(socket)))
}
console.log(
  "Private sockets: UTF-8 limits, distinct sessions, owner-only modes, long TMPDIR, idempotent cleanup, dead-owner reaping and live/unrelated preservation passed"
)
