import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { openCodeLegacyFetch } from "@mako/host/harnesses/opencode/legacy-api"
import { startOpenCodeApi } from "@mako/host/harnesses/opencode/native-api"
import { OpenCodeServers } from "@mako/host/harnesses/opencode/servers"
import { ProviderLaunchTrace } from "@mako/host/harnesses/provider-launch"

const servers = new OpenCodeServers()

const root = await mkdtemp(join(tmpdir(), "mako-opencode-api-boundary-"))
try {
  const cases = [
    { name: "remote-readiness", code: 'console.log(JSON.stringify({url:"http://example.com/"})); setInterval(()=>{}, 1000)', error: /invalid API readiness/ },
    { name: "oversized-readiness", code: 'process.stdout.write("x".repeat(9000)); setInterval(()=>{},1000)', error: /readiness exceeded/ },
    { name: "early-exit", code: 'process.exit(2)', error: /exited/ },
    { name: "wrong-process", code: `
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({version:"2.0.27", pid:process.pid+1, urls:[], paths:{tmp:"/tmp"}}))
      })
      server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({url:"http://127.0.0.1:"+server.address().port})))
    `, error: /does not belong to the launched process/ },
    { name: "newer-release", code: `
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({version:"2.9.0", pid:process.pid+1, urls:[], paths:{tmp:"/tmp"}}))
      })
      server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({url:"http://127.0.0.1:"+server.address().port})))
    `, error: /does not belong to the launched process/ },
    { name: "outdated-release", code: `
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({version:"0.0.0-beta-19425", pid:process.pid, urls:[], paths:{tmp:"/tmp"}}))
      })
      server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({url:"http://127.0.0.1:"+server.address().port})))
    `, error: /OpenCode 0\.0\.0-beta-19425 is older than Mako supports\. Update OpenCode to 2\.0\.0 or newer/ },
    { name: "wrong-generation", code: `
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({version:"1.18.32", pid:process.pid, urls:[], paths:{tmp:"/tmp"}}))
      })
      server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({url:"http://127.0.0.1:"+server.address().port})))
    `, error: /Mako runs OpenCode 2\.0\.0 or newer; this executable reports "1\.18\.32"/ },
  ]
  for (const fixture of cases) {
    const command = join(root, fixture.name + ".mjs")
    const pidPath = command + ".pid"
    await writeFile(command, `#!${process.execPath}\nimport {createServer} from "node:http"; import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(pidPath)},String(process.pid)); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));\n${fixture.code}`, { mode: 0o700 })
    await assert.rejects(startOpenCodeApi({ servers, command, cwd: root, env: process.env, conversationId: fixture.name,
      trace: new ProviderLaunchTrace({ provider: "opencode", conversation: fixture.name }, { report() {} }),
    }), fixture.error)
    const pid = Number(await readFile(pidPath, "utf8"))
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `${fixture.name} must reap its own failed child`)
  }
  await assert.rejects(startOpenCodeApi({ servers, command: join(root, "missing"), cwd: root, env: process.env, conversationId: "missing",
    trace: new ProviderLaunchTrace({ provider: "opencode", conversation: "missing" }, { report() {} }),
  }), /ENOENT/)
  const cancelled = new AbortController()
  cancelled.abort(new Error("Owner replaced before launch"))
  await assert.rejects(startOpenCodeApi({ servers, command: join(root, "must-not-spawn"), cwd: root, env: process.env, conversationId: "cancelled",
    signal: cancelled.signal, trace: new ProviderLaunchTrace({ provider: "opencode", conversation: "cancelled" }, { report() {} }),
  }), /Owner replaced/)
  const duringLaunch = new AbortController()
  await assert.rejects(startOpenCodeApi({ servers, command: join(root, "early-exit.mjs"), cwd: root, env: process.env, conversationId: "cancelled-during-launch",
    signal: duringLaunch.signal,
    trace: new ProviderLaunchTrace({ provider: "opencode", conversation: "cancelled-during-launch" }, { report(phase) {
      if (phase.phase === "handshake" && phase.state === "started") duringLaunch.abort()
    } }),
  }), /disposed|abandoned/)
  // A server from before `/api/info` (2.0.6) is the spawned process at the version its executable reports,
  // and one from before 2.0.4 reads a permission reply's choice as `reply`.
  for (const [version, info, body] of [["2.0.1", false, { reply: "once" }], ["2.0.27", true, { decision: "once" }]] as const) {
    const command = join(root, `server-${version}.mjs`)
    const replies = command + ".replies"
    await writeFile(command, `#!${process.execPath}
import {createServer} from "node:http"; import {appendFileSync} from "node:fs"
if (process.argv[2] === "--version") { console.log("opencode v${version}"); process.exit(0) }
process.stdin.resume(); process.stdin.on("end",()=>process.exit(0))
const server = createServer((request, response) => {
  if (request.url === "/api/info" && ${info}) { response.setHeader("content-type", "application/json"); return response.end(JSON.stringify({version:"${version}", pid:process.pid, urls:[], paths:{tmp:"/tmp"}})) }
  if (request.method === "POST" && request.url === "/api/session/ses_1/permission/per_1/reply") {
    let body = ""; request.on("data", chunk => { body += chunk }); request.on("end", () => { appendFileSync(${JSON.stringify(replies)}, body + "\\n"); response.statusCode = 204; response.end() })
    return
  }
  response.statusCode = 404; response.end()
})
server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({url:"http://127.0.0.1:"+server.address().port})))
`, { mode: 0o700 })
    const api = await startOpenCodeApi({ servers, command, cwd: root, env: process.env, conversationId: `server-${version}`,
      trace: new ProviderLaunchTrace({ provider: "opencode", conversation: `server-${version}` }, { report() {} }),
    })
    try {
      assert.equal(api.info.version, version, `${version} is named whether or not it answers /api/info`)
      await api.client.permission.reply({ sessionID: "ses_1", requestID: "per_1", decision: "once" })
      assert.deepEqual(JSON.parse((await readFile(replies, "utf8")).trim()), body, `${version} reads the reply it understands`)
    } finally { await api.close() }
  }
  // Each request whose shape 2.0.4 changed, as the API before it reads them.
  const sent: Array<{ method: string; path: string; body?: unknown }> = []
  const old = openCodeLegacyFetch(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? "GET"
    sent.push({ method, path: url.pathname + url.search, ...typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {} })
    if (url.pathname.endsWith("/message")) return Response.json({ data: [{ id: "msg_last" }], cursor: {} })
    if (url.pathname.endsWith("/state")) return Response.json({ data: { status: "answered", answer: { pick: "a" } } })
    if (method === "GET") return Response.json({ data: { id: "frm_1", title: "Pick" } })
    if (url.pathname.endsWith("/fork")) return Response.json({ data: { id: "ses_2" } })
    return new Response(null, { status: 204 })
  })
  const legacy = OpenCode.make({ baseUrl: "http://127.0.0.1:1", fetch: old })
  await legacy.permission.reply({ sessionID: "ses_1", requestID: "per_1", decision: "reject", message: "no" })
  await legacy.session.command({ sessionID: "ses_1", name: "review", text: "this" })
  await legacy.session.fork({ sessionID: "ses_1", before: "msg_2" })
  await legacy.session.fork({ sessionID: "ses_1" })
  await legacy.session.form.cancel({ sessionID: "ses_1", formID: "frm_1" })
  await legacy.mcp.add({ server: "notes", location: { directory: "/p" }, config: { type: "local", command: ["notes"] } })
  const form = await legacy.session.form.get({ sessionID: "ses_1", formID: "frm_1" })
  assert.deepEqual(form.state, { status: "answered", answer: { pick: "a" } }, "a form's state comes from the route that served it")
  assert.equal(form.id, "frm_1")
  assert.deepEqual(sent.map(({ method, path, body }) => [method, path, body]), [
    ["POST", "/api/session/ses_1/permission/per_1/reply", { reply: "reject", message: "no" }],
    ["POST", "/api/session/ses_1/command", { command: "review", text: "this" }],
    ["POST", "/api/session/ses_1/fork", { boundary: { type: "before", messageID: "msg_2" } }],
    ["GET", "/api/session/ses_1/message?order=desc&limit=1", undefined],
    ["POST", "/api/session/ses_1/fork", { boundary: { type: "through", messageID: "msg_last" } }],
    ["POST", "/api/session/ses_1/form/frm_1/cancel", undefined],
    ["PUT", "/api/mcp/notes?location%5Bdirectory%5D=%2Fp", { config: { type: "local", command: ["notes"] } }],
    ["GET", "/api/session/ses_1/form/frm_1", undefined],
    ["GET", "/api/session/ses_1/form/frm_1/state", undefined],
  ])
  console.log("OpenCode native API: bounded local readiness, exact process, supported versions (newer included), servers before /api/info, the API before 2.0.4, failed-spawn cleanup and native lease shutdown passed")
} finally { await rm(root, { recursive: true, force: true }) }
