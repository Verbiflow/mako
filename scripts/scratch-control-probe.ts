import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createControlRuntime } from "@mako/control-runtime"
import { createControlMcpServer } from "@mako/control-runtime/mcp"
import {
  readControlSession,
  invokeControlSession,
  serveControlSession,
} from "@mako/control-runtime/session"

const executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const root = await mkdtemp(join(tmpdir(), "mako-probe-"))
const chromium = spawn(
  executable,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${join(root, "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
)
const endpoint = await new Promise<string>((resolve) => {
  let stderr = ""
  chromium.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
    const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/)
    if (match) resolve(match[1]!)
  })
})
const runtime = createControlRuntime({
  artifacts: join(root, "artifacts"),
  browsers: [{ id: "live", name: "Live Chromium", endpoint: async () => endpoint }],
})
const owner = await serveControlSession(runtime)
const descriptor = await readControlSession(owner.file)
const server = createControlMcpServer((operation, signal) =>
  invokeControlSession(descriptor, operation, signal ?? new AbortController().signal)
)
const client = new Client({ name: "probe", version: "1" })
const [a, b] = InMemoryTransport.createLinkedPair()
await server.connect(b)
await client.connect(a)
const log: string[] = []
const js = async (label: string, code: string) => {
  const started = performance.now()
  const result = (await client.callTool({ name: "js", arguments: { code, timeout_ms: 45_000 } })) as {
    isError?: boolean
    content: Array<{ type: string; text?: string; data?: string }>
  }
  const ms = Math.round(performance.now() - started)
  const text = result.content.map((c) => (c.type === "text" ? c.text : `[${c.type} ${c.data?.length ?? 0}b64]`)).join("\n---\n")
  log.push(`### ${label} (${text.length} chars, ${ms} ms${result.isError ? ", ERROR" : ""})\n${code}\n>>>\n${text}\n`)
  console.log(label, text.length, ms, result.isError ? "ERROR" : "")
}
const scenarios = (process.env.PROBE ?? "basic").split(",")
try {
  await js("browsers", "await control.browsers()")
  await js("connect", `await control.connectBrowser("live")`)
  for (const url of (process.env.URLS ?? "https://news.ycombinator.com").split(",")) {
    await js(`open ${url}`, `const tab = await control.openTab({browser:"live", url:${JSON.stringify(url)}}); tab`)
    if (scenarios.includes("dump")) {
      const slug = url.replace(/\W+/g, "_").slice(8, 60)
      await js(`dump ${slug}`, `const all = await tab.observe({max:1000}); const fs = await import("node:fs/promises"); await fs.writeFile("/tmp/mako-cu-audit/nodes-${slug}.json", JSON.stringify({nodes: all.nodes, coverage: all.coverage})); all.nodes.length`)
      await js(`dump-i ${slug}`, `const ia = await tab.observe({max:1000, interactive:true}); await (await import("node:fs/promises")).writeFile("/tmp/mako-cu-audit/inodes-${slug}.json", JSON.stringify({nodes: ia.nodes})); ia.nodes.length`)
      continue
    }
    await js("observe default", "await tab.observe()")
    await js("observe interactive", "await tab.observe({interactive:true})")
    if (scenarios.includes("act")) {
      await js("observe query", `await tab.observe({query:${JSON.stringify(process.env.QUERY ?? "login")}})`)
      await js("screenshot", "const shot = await tab.screenshot(); shot")
      await js("shot fields", "const {data, ...rest} = shot; rest")
      await js("tabs", `await control.tabs("live")`)
      await js("click first link", `const v = await tab.observe({interactive:true}); const link = v.nodes.find(n=>n.role==="link"); await tab.click(link.ref)`)
      await js("expect url", `await tab.expect({url:{contains:"/"}})`)
      await js("type miss", `await tab.locator({role:"textbox",name:"Nope"}).type("x")`)
      await js("read", `await tab.read?.() ?? "no read"`)
    }
  }
} finally {
  await writeFile(process.env.OUT ?? "/tmp/mako-cu-audit/probe.md", log.join("\n"))
  await client.close()
  await server.close()
  await owner.close()
  await runtime.close()
  const exited = new Promise((resolve) => chromium.once("exit", resolve))
  chromium.kill()
  await exited
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
}
