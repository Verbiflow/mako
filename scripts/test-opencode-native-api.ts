import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOpenCodeApi } from "../electron/providers/opencode/native-api.js"
import { ProviderLaunchTrace } from "../electron/provider-launch.js"

const root = await mkdtemp(join(tmpdir(), "mako-opencode-api-boundary-"))
try {
  const cases = [
    { name: "remote-readiness", code: 'console.log(JSON.stringify({url:"http://example.com/"})); setInterval(()=>{}, 1000)', error: /invalid API readiness/ },
    { name: "oversized-readiness", code: 'process.stdout.write("x".repeat(9000)); setInterval(()=>{},1000)', error: /readiness exceeded/ },
    { name: "early-exit", code: 'process.exit(2)', error: /exited/ },
    { name: "wrong-process", code: `
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({healthy:true, version:"2.0.1", pid:process.pid+1}))
      })
      server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({url:"http://127.0.0.1:"+server.address().port})))
    `, error: /does not belong to the launched process/ },
    { name: "wrong-generation", code: `
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({healthy:true, version:"1.18.32", pid:process.pid}))
      })
      server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({url:"http://127.0.0.1:"+server.address().port})))
    `, error: /requires a v2 runtime/ },
  ]
  for (const fixture of cases) {
    const command = join(root, fixture.name + ".mjs")
    const pidPath = command + ".pid"
    await writeFile(command, `#!${process.execPath}\nimport {createServer} from "node:http"; import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(pidPath)},String(process.pid)); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));\n${fixture.code}`, { mode: 0o700 })
    await assert.rejects(startOpenCodeApi({ command, cwd: root, env: process.env, conversationId: fixture.name,
      trace: new ProviderLaunchTrace({ provider: "opencode", conversation: fixture.name }, { report() {} }),
    }), fixture.error)
    const pid = Number(await readFile(pidPath, "utf8"))
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `${fixture.name} must reap its own failed child`)
  }
  await assert.rejects(startOpenCodeApi({ command: join(root, "missing"), cwd: root, env: process.env, conversationId: "missing",
    trace: new ProviderLaunchTrace({ provider: "opencode", conversation: "missing" }, { report() {} }),
  }), /ENOENT/)
  const cancelled = new AbortController()
  cancelled.abort(new Error("Owner replaced before launch"))
  await assert.rejects(startOpenCodeApi({ command: join(root, "must-not-spawn"), cwd: root, env: process.env, conversationId: "cancelled",
    signal: cancelled.signal, trace: new ProviderLaunchTrace({ provider: "opencode", conversation: "cancelled" }, { report() {} }),
  }), /Owner replaced/)
  const duringLaunch = new AbortController()
  await assert.rejects(startOpenCodeApi({ command: join(root, "early-exit.mjs"), cwd: root, env: process.env, conversationId: "cancelled-during-launch",
    signal: duringLaunch.signal,
    trace: new ProviderLaunchTrace({ provider: "opencode", conversation: "cancelled-during-launch" }, { report(phase) {
      if (phase.phase === "handshake" && phase.state === "started") duringLaunch.abort()
    } }),
  }), /disposed|abandoned/)
  console.log("OpenCode native API: bounded local readiness, exact process/version, failed-spawn cleanup and native lease shutdown passed")
} finally { await rm(root, { recursive: true, force: true }) }
