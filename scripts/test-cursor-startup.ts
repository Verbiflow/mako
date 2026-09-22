import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CursorSdkClient, CursorSdkError } from "../electron/providers/cursor/sdk/client.ts"
import { CURSOR_SDK_WIRE_VERSION } from "../electron/providers/cursor/sdk/wire.ts"

const root = await mkdtemp(join(tmpdir(), "cursor-startup-"))
try {
  for (const mode of ["progress", "silence", "chatter", "exit", "auth-refusal"] as const) {
    const entry = join(root, `${mode}.mjs`)
    await writeFile(entry, `
      import { createInterface } from 'node:readline';
      createInterface({input:process.stdin}).on('line', line => {
        const req=JSON.parse(line);
        if (${JSON.stringify(mode)} === 'exit') process.exit(7);
        if (${JSON.stringify(mode)} === 'silence') return;
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
    `)
    const client = new CursorSdkClient({
      owner: "startup-fixture", cwd: root, env: {}, entry,
      execPath: process.execPath, onEvent() {},
      requestTimeoutMs: 30,
      startupTimeouts: { silenceMs: 200, totalMs: 900 },
    })
    try {
      if (mode === "progress") {
        await client.hello()
        assert.equal(client.alive, true, "startup progress outlives the old request deadline")
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
      client.kill()
      await client.exited
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
