import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import { join } from "node:path"
import { CursorSdkClient, CursorSdkError } from "@mako/host/harnesses/cursor/sdk/client"
import { CURSOR_SDK_WIRE_VERSION } from "@mako/host/harnesses/cursor/sdk/wire"

/**
 * Listens at `socket` for a fixture to connect, which it does once it reads its requests: `started` settles then. A step's silence counts from the
 * request, and the runtime's own start counts in it: on a loaded runner a child took longer than this test's 200 ms
 * to start, and a case failed as silent before the fixture could say anything.
 */
async function startedAt(socket: string): Promise<{ started: Promise<void>; close(): void }> {
  const server = createServer()
  const started = new Promise<void>((resolve) => server.once("connection", (connection) => {
    connection.destroy()
    resolve()
  }))
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, resolve))
  return { started, close: () => server.close() }
}

const root = await mkdtemp(join(tmpdir(), "cursor-startup-"))
try {
  for (const mode of ["progress", "silence", "chatter", "exit", "auth-refusal", "network-refusal"] as const) {
    const entry = join(root, `${mode}.mjs`)
    const socket = join(root, `${mode}.sock`)
    const listening = await startedAt(socket)
    await writeFile(entry, `
      import { connect } from 'node:net';
      import { createInterface } from 'node:readline';
      createInterface({input:process.stdin}).on('line', line => {
        const req=JSON.parse(line);
        if (${JSON.stringify(mode)} === 'exit') process.exit(7);
        if (${JSON.stringify(mode)} === 'silence') return;
        if (${JSON.stringify(mode)} === 'network-refusal') {
          process.stdout.write(JSON.stringify({id:req.id,ok:false,error:{kind:'network',message:'Network request failed',networkCauses:['UND_ERR_CONNECT_TIMEOUT'],retryable:true}})+'\\n');
          return;
        }
        if (${JSON.stringify(mode)} === 'auth-refusal') {
          process.stdout.write(JSON.stringify({id:req.id,ok:false,error:{kind:'authentication',message:'Sign in',retryable:false}})+'\\n');
          return;
        }
        const timer=setInterval(()=>process.stderr.write('progress\\n'),20);
        if (${JSON.stringify(mode)} === 'progress') setTimeout(()=>{
          clearInterval(timer);
          process.stdout.write(JSON.stringify({id:req.id,ok:true,result:{wire:${CURSOR_SDK_WIRE_VERSION},sdkVersion:'fixture',node:process.versions.node}})+'\\n');
        },250);
      });
      connect(${JSON.stringify(socket)}).on('error', () => {}).end();
    `)
    const client = new CursorSdkClient({
      owner: "startup-fixture", cwd: root, env: {}, entry,
      execPath: process.execPath, onEvent() {},
      requestTimeoutMs: 30,
      startupTimeouts: { silenceMs: 200, totalMs: 900 },
    })
    try {
      await Promise.race([listening.started, client.exited])
      if (mode === "progress") {
        await client.hello()
        assert.equal(client.alive, true, "startup progress outlives the old request deadline")
      } else if (mode === "network-refusal") {
        await assert.rejects(client.request("models", undefined), error => error instanceof CursorSdkError && error.kind === "network" && error.networkCauses?.[0] === "UND_ERR_CONNECT_TIMEOUT")
        assert.equal(client.alive, true, "a native network error is not a startup silence timeout")
      } else if (mode === "auth-refusal") {
        await assert.rejects(client.request("authStatus", undefined), CursorSdkError)
        assert.equal(client.alive, true, "a typed auth refusal must preserve the sign-in client")
      } else {
        await assert.rejects(client.hello(), mode === "silence" ? /no output/ : mode === "chatter" ? /did not finish/ : /exit|closed/)
        await client.exited
        assert.equal(client.alive, false, "a failed startup must not leave its executor behind")
      }
      console.log(`Cursor shared startup: ${mode} passed`)
    } finally {
      listening.close()
      client.kill()
      await client.exited
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
