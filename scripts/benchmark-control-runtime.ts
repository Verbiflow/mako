/**
 * Measures the control surface a checkout exposes to an agent: how much of
 * the model's context the tool catalog costs, what one action and one
 * workflow return, and what happens to a result larger than the inline
 * budget. It detects the surface from the tool list, so the same file runs
 * against the prior per-action servers (copied into a worktree of that
 * revision) and against the program servers, and the two JSON reports are
 * comparable line by line. Fixtures stand in for Chrome and the native
 * driver; nothing here measures a page or an application.
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { z } from "zod"
import { createBrowserToolsServer } from "../electron/browser-tools-main.js"
import { createComputerToolsServer } from "../electron/computer-tools-main.js"
import { ensureCuaEmbedded, stopCuaEmbedded } from "../electron/cua-embedded.js"
import { resolveExecutable } from "../electron/executable.js"
import type { BrowserCommand } from "../electron/contracts/browser-control.js"
import type { JsonValue } from "../electron/codex-app-json.js"

const RUNS = 20
const OVERSIZE_CHARACTERS = 300_000

process.env.MAKO_CONTROL_ARTIFACTS ??= await mkdtemp(
  join(tmpdir(), "mako-control-benchmark-")
)

const toolResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(
    z
      .object({
        type: z.string(),
        text: z.string().optional(),
        data: z.string().optional(),
      })
      .loose()
  ),
})
type ToolResult = z.infer<typeof toolResult>

function resultBytes(result: ToolResult): number {
  return result.content.reduce(
    (total, block) => total + Buffer.byteLength(block.text ?? block.data ?? ""),
    0
  )
}

async function measure(run: () => Promise<void>) {
  const durations: number[] = []
  for (let index = 0; index < RUNS; index++) {
    const started = performance.now()
    await run()
    durations.push(performance.now() - started)
  }
  durations.sort((left, right) => left - right)
  return {
    medianMs: Number(durations[Math.floor(durations.length / 2)]!.toFixed(3)),
    p95Ms: Number(
      durations[Math.ceil(durations.length * 0.95) - 1]!.toFixed(3)
    ),
  }
}

interface Lane {
  agentCalls: number
  hostActions: number
  responseBytes: number
  latency: { medianMs: number; p95Ms: number }
}

interface Oversize {
  outcome: "inline" | "artifact" | "failed"
  responseBytes: number
  detail: string
}

async function connect(server: Server, name: string) {
  const client = new Client({ name, version: "1" })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const { tools } = await client.listTools()
  const call = async (tool: string, args: Record<string, JsonValue>) =>
    toolResult.parse(await client.callTool({ name: tool, arguments: args }))
  return {
    client,
    call,
    catalog: {
      tools: tools.length,
      names: tools.map((tool) => tool.name),
      catalogBytes: Buffer.byteLength(JSON.stringify(tools)),
      instructionBytes: Buffer.byteLength(client.getInstructions() ?? ""),
    },
    has: (tool: string) => tools.some((entry) => entry.name === tool),
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/** The program lane's return value: what an agent would read from a run. */
function programValue(result: ToolResult): JsonValue {
  const last = result.content.at(-1)
  return z.json().parse(JSON.parse(last?.text ?? "null"))
}

function oversizeVerdict(result: ToolResult): Oversize {
  const bytes = resultBytes(result)
  const text = result.content.map((block) => block.text ?? "").join("\n")
  if (result.isError)
    return {
      outcome: "failed",
      responseBytes: bytes,
      detail: text.slice(0, 160),
    }
  if (text.includes('"artifact":true')) {
    const receipt = z
      .object({ path: z.string(), bytes: z.number() })
      .loose()
      .parse(JSON.parse(result.content.at(-1)?.text ?? "{}"))
    return {
      outcome: "artifact",
      responseBytes: bytes,
      detail: `${receipt.bytes} bytes written whole to ${receipt.path}`,
    }
  }
  return {
    outcome: "inline",
    responseBytes: bytes,
    detail: `${bytes} bytes returned inline`,
  }
}

// Browser fixture: a form with 180 controls, five-step workflow, one
// oversized evaluate result.
const target = {
  browser: "fixture",
  tab: "tab-1",
  generation: "generation-1",
  lease: "lease-1",
}
const observation = {
  target,
  title: "Control benchmark",
  url: "https://example.test/form",
  scroll: { x: 0, y: 0 },
  nodes: Array.from({ length: 180 }, (_, index) => ({
    ref: `abcdef:${index}`,
    depth: index % 4,
    role: index % 3 === 0 ? "textbox" : "button",
    name: `Control ${index} ${"description ".repeat(8)}`,
    value: index % 3 === 0 ? `Value ${index}` : "",
  })),
}
const oversized = "x".repeat(OVERSIZE_CHARACTERS)
let browserActions = 0
const browserCall = async (command: BrowserCommand): Promise<JsonValue> => {
  browserActions++
  switch (command.action) {
    case "status":
      return [{ id: "fixture", connection: { status: "connected" } }]
    case "tabs":
      return [
        { id: target.tab, title: observation.title, url: observation.url },
      ]
    case "observe":
      return observation
    case "click":
      return { clicked: true }
    case "evaluate":
      return oversized
    default:
      return null
  }
}
const browserWorkflowDirect: [string, Record<string, JsonValue>][] = [
  ["mako_browser_status", {}],
  ["mako_browser_tabs", { browser: "fixture" }],
  ["mako_browser_observe", { target }],
  ["mako_browser_click", { target, at: { ref: observation.nodes[0]!.ref } }],
  ["mako_browser_observe", { target }],
]
const browserWorkflowProgram = `
const status = await browser.status()
const tabs = await browser.tabs({browser: "fixture"})
const first = await browser.observe({target: ${JSON.stringify(target)}})
await browser.click({target: ${JSON.stringify(target)}, at: {ref: first.nodes[0].ref}})
const final = await browser.observe({target: ${JSON.stringify(target)}})
return {connected: status[0].connection.status, tab: tabs[0].id, title: final.title, controls: final.nodes.length}
`

// Computer fixture: a window with 180 elements, a two-step workflow, one
// oversized accessibility tree.
const driverSource = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
const server = new Server({name:"control-benchmark",version:"1"},{capabilities:{tools:{}}})
const target = {session:{type:"string"},pid:{type:"integer"},window_id:{type:"integer"},element_token:{type:"string"},max_elements:{type:"integer"}}
server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[
  {name:"get_window_state",description:"Window tree and screenshot.",inputSchema:{type:"object",properties:target,required:["session","pid","window_id"]}},
  {name:"click",description:"Click.",inputSchema:{type:"object",properties:target,required:["session"]}},
  {name:"get_accessibility_tree",description:"Whole tree.",inputSchema:{type:"object",properties:target,required:["session","pid"]}}
]}))
const elements = Array.from({length:180},(_,index)=>({element_token:"s0000000a:"+index,role:index%3===0?"AXTextField":"AXButton",label:"Control "+index+" "+"description ".repeat(8)}))
server.setRequestHandler(CallToolRequestSchema,request=>{
  const args=request.params.arguments
  if(request.params.name==="get_window_state"){
    const value={snapshot_id:"s0000000a",pid:args.pid,window_id:args.window_id,max_elements:args.max_elements,elements,tree_markdown:elements.map(item=>item.label).join("\\n"),_note:"duplicate tree"}
    return {content:[{type:"text",text:JSON.stringify(value)}],structuredContent:value}
  }
  if(request.params.name==="get_accessibility_tree"){
    const value={pid:args.pid,tree:"x".repeat(${OVERSIZE_CHARACTERS})}
    return {content:[{type:"text",text:JSON.stringify(value)}],structuredContent:value}
  }
  return {content:[{type:"text",text:JSON.stringify({clicked:true,pid:args.pid,window_id:args.window_id,session:args.session})}]}
})
await server.connect(new StdioServerTransport())
`
const computerWorkflowProgram =
  "const view = await computer.get_window_state({pid:42,window_id:7}); const click = await computer.click({element_token:view.structuredContent.elements[0].element_token}); return {snapshot:view.structuredContent.snapshot_id,controls:view.structuredContent.elements.length,clicked:JSON.parse(click.content[0].text).clicked}"

interface SurfaceReport {
  catalog: Awaited<ReturnType<typeof connect>>["catalog"]
  single: Partial<Record<"direct" | "program", Lane>>
  workflow: Partial<Record<"direct" | "program", Lane>>
  oversize: Partial<Record<"direct" | "program", Oversize>>
}

async function lane(
  agentCalls: number,
  run: () => Promise<ToolResult[]>
): Promise<Lane> {
  browserActions = 0
  const results = await run()
  const hostActions = browserActions
  const latency = await measure(async () => {
    await run()
  })
  return {
    agentCalls,
    hostActions,
    responseBytes: results.reduce(
      (total, result) => total + resultBytes(result),
      0
    ),
    latency,
  }
}

async function benchmarkBrowser(): Promise<SurfaceReport> {
  const surface = await connect(
    createBrowserToolsServer((command) => browserCall(command)),
    "control-benchmark-browser"
  )
  try {
    const report: SurfaceReport = {
      catalog: surface.catalog,
      single: {},
      workflow: {},
      oversize: {},
    }
    if (surface.has("mako_browser_observe")) {
      report.single.direct = await lane(1, async () => [
        await surface.call("mako_browser_observe", { target }),
      ])
      report.workflow.direct = await lane(
        browserWorkflowDirect.length,
        async () => {
          const results: ToolResult[] = []
          for (const [tool, args] of browserWorkflowDirect)
            results.push(await surface.call(tool, args))
          return results
        }
      )
      report.oversize.direct = oversizeVerdict(
        await surface.call("mako_browser_evaluate", {
          target,
          expression: "document.body.innerText",
        })
      )
    }
    if (surface.has("mako_browser_exec")) {
      const exec = (source: string) =>
        surface.call("mako_browser_exec", { source })
      report.single.program = await lane(1, async () => [
        await exec(
          `return await browser.observe({target: ${JSON.stringify(target)}})`
        ),
      ])
      const workflow = await exec(browserWorkflowProgram)
      const value = programValue(workflow)
      if (
        JSON.stringify(value) !==
        '{"connected":"connected","tab":"tab-1","title":"Control benchmark","controls":180}'
      )
        throw new Error(`browser workflow returned ${JSON.stringify(value)}`)
      report.workflow.program = await lane(1, async () => [
        await exec(browserWorkflowProgram),
      ])
      report.oversize.program = oversizeVerdict(
        await exec(
          `return await browser.evaluate({target: ${JSON.stringify(target)}, expression: "document.body.innerText"})`
        )
      )
    }
    return report
  } finally {
    await surface.close()
  }
}

async function benchmarkComputer(): Promise<SurfaceReport> {
  const surface = await connect(
    createComputerToolsServer(
      {
        command: process.execPath,
        args: ["--input-type=module", "--eval", driverSource],
      },
      "benchmark"
    ),
    "control-benchmark-computer"
  )
  try {
    const report: SurfaceReport = {
      catalog: surface.catalog,
      single: {},
      workflow: {},
      oversize: {},
    }
    if (surface.has("mako_computer_get_window_state")) {
      report.single.direct = await lane(1, async () => [
        await surface.call("mako_computer_get_window_state", {
          pid: 42,
          window_id: 7,
        }),
      ])
      report.workflow.direct = await lane(2, async () => {
        const view = await surface.call("mako_computer_get_window_state", {
          pid: 42,
          window_id: 7,
        })
        const token = z
          .object({
            elements: z.array(z.object({ element_token: z.string() })),
          })
          .parse(JSON.parse(view.content[0]?.text ?? "{}")).elements[0]!
          .element_token
        const click = await surface.call("mako_computer_click", {
          element_token: token,
        })
        return [view, click]
      })
      report.workflow.direct.hostActions = 2
      report.single.direct.hostActions = 1
      report.oversize.direct = oversizeVerdict(
        await surface.call("mako_computer_get_accessibility_tree", { pid: 42 })
      )
    }
    if (surface.has("mako_computer_exec")) {
      const exec = (source: string) =>
        surface.call("mako_computer_exec", { source })
      report.single.program = await lane(1, async () => [
        await exec(
          "return await computer.get_window_state({pid:42,window_id:7})"
        ),
      ])
      report.single.program.hostActions = 1
      const workflow = await exec(computerWorkflowProgram)
      const value = programValue(workflow)
      if (
        JSON.stringify(value) !==
        '{"snapshot":"s0000000a","controls":180,"clicked":true}'
      )
        throw new Error(`computer workflow returned ${JSON.stringify(value)}`)
      report.workflow.program = await lane(1, async () => [
        await exec(computerWorkflowProgram),
      ])
      report.workflow.program.hostActions = 2
      report.oversize.program = oversizeVerdict(
        await exec("return await computer.get_accessibility_tree({pid:42})")
      )
    }
    return report
  } finally {
    await surface.close()
  }
}

/**
 * The fixture driver publishes three tools, so the computer catalog above
 * says nothing about the installed driver's sixty-odd. With
 * MAKO_CONTROL_LIVE_DRIVER=1 the installed cua-driver's catalog is listed
 * through the same server; nothing is clicked.
 */
async function liveComputerCatalog() {
  if (process.env.MAKO_CONTROL_LIVE_DRIVER !== "1") return undefined
  // A Unix socket path is bounded (SUN_LEN), so the state directory stays short.
  const socket = await ensureCuaEmbedded(
    await mkdtemp(join(tmpdir(), "mako-cb-")),
    "dev.mako.benchmark"
  )
  if (!socket) return undefined
  const surface = await connect(
    createComputerToolsServer(
      {
        command: resolveExecutable("cua-driver"),
        args: ["mcp", "--embedded", "--socket", socket],
      },
      "benchmark-live"
    ),
    "control-benchmark-live"
  )
  try {
    return surface.catalog
  } finally {
    await surface.close()
    stopCuaEmbedded()
  }
}

const browser = await benchmarkBrowser()
const computer = await benchmarkComputer()
const liveComputer = await liveComputerCatalog()
console.log(
  JSON.stringify(
    {
      runs: RUNS,
      oversizeCharacters: OVERSIZE_CHARACTERS,
      artifacts: process.env.MAKO_CONTROL_ARTIFACTS,
      browser,
      computer,
      liveComputerCatalog: liveComputer ?? null,
      backgroundInterference: {
        deterministicCoverage: false,
        liveCheck: "npm run test:local-control-e2e",
        invariant: "frontmost application remains unchanged",
      },
    },
    null,
    2
  )
)
