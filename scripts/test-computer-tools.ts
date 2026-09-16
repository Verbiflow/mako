import assert from "node:assert/strict"
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:http"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import {
  BACKGROUND_INPUT_LADDER,
  createComputerToolsServer,
} from "../electron/computer-tools-main.js"
import { canonicalDriverPath } from "../electron/computer-paths.js"

const source = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[{name:'get_window_state',description:'Native capture',inputSchema:{type:'object',properties:{session:{type:'string'},pid:{type:'integer'}},required:['session','pid']},annotations:{readOnlyHint:true}}]}));
server.setRequestHandler(CallToolRequestSchema,request=>({content:[{type:'image',mimeType:'image/png',data:'aW1hZ2U='},{type:'text',text:JSON.stringify(request.params.arguments)}],structuredContent:{session:request.params.arguments.session,pid:request.params.arguments.pid,max_elements:request.params.arguments.max_elements,screenshot_scale:2}}));
await server.connect(new StdioServerTransport());
`
// A driver-shaped fixture: numeric formats in its schemas, a window-state
// result that names its snapshot and writes the capture to disk, an
// unverifiable hotkey, an app list whose active app is never the target, a
// huge accessibility tree, and an echo of every forwarded argument.
const driverSource = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({name:'driver',version:'1'},{capabilities:{tools:{}}});
const target = {session:{type:'string'},pid:{type:'integer',format:'int32'},window_id:{type:'integer',format:'uint32'},element_token:{type:'string'},snapshot_id:{type:'string'},max_elements:{type:'integer',format:'uint32'},screenshot_out_file:{type:'string'},delivery_mode:{type:'string',enum:['background','foreground']}};
server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[
  {name:'get_window_state',description:'Capture. Returns both.',inputSchema:{type:'object',properties:target,required:['session','pid','window_id']},outputSchema:{type:'object',properties:{snapshot_id:{type:'string'},pid:{type:'integer',format:'int32'},window_id:{type:'integer',format:'uint32'},screenshot_scale:{type:'number',format:'double'}},required:['snapshot_id']}},
  {name:'click',description:'Click',inputSchema:{type:'object',properties:target,required:['session']}},
  {name:'hotkey',description:'Press a key combination.',inputSchema:{type:'object',properties:{...target,keys:{type:'array',items:{type:'string'}}},required:['session','keys']}},
  {name:'list_apps',description:'Apps',inputSchema:{type:'object',properties:{session:{type:'string'}}}},
  {name:'list_windows',description:'Windows',inputSchema:{type:'object',properties:{session:{type:'string'},pid:{type:'integer'},on_screen_only:{type:'boolean'}}}},
  {name:'get_accessibility_tree',description:'Whole tree',inputSchema:{type:'object',properties:target,required:['session','pid']}},
  {name:'zoom',description:'Zoom',inputSchema:{type:'object',properties:target,required:['session','pid','window_id']}},
  {name:'invoke_menu',description:'Invoke a menu item.',inputSchema:{type:'object',properties:{...target,path:{type:'array',items:{type:'string'}}},required:['session','pid','window_id','path']}},
  {name:'set_value',description:'Set a value.',inputSchema:{type:'object',properties:{...target,value:{type:'string'}},required:['session','element_token','value']}},
  {name:'set_agent_cursor_enabled',description:'Show or hide the agent cursor owned by a session.',inputSchema:{type:'object',properties:{session:{type:'string'},enabled:{type:'boolean'}},required:['session','enabled']}},
  {name:'set_agent_cursor_motion',description:'Configure only movement physics and visibility timing for a session cursor.',inputSchema:{type:'object',properties:{session:{type:'string'},glide_duration_ms:{type:['number','null']},dwell_after_click_ms:{type:['number','null']}},required:['session']}},
  {name:'get_config',description:'Config.',inputSchema:{type:'object',properties:{}}}
]}));
const cursorCalls=[];
let clicks=0; let fieldValue=''; let captures=0; let newest='';
// Like the driver: every capture is a new snapshot and only the newest
// snapshot's tokens are honoured.
const stale=(token)=>typeof token==='string'&&token!=='refuse'&&!token.startsWith(newest+':');
server.setRequestHandler(CallToolRequestSchema,async request=>{
  const args=request.params.arguments;
  if(request.params.name==='get_window_state'){
    captures+=1; newest='s'+(10+captures).toString(16).padStart(8,'0');
    const elements=[{element_token:newest+':0',role:'AXButton',label:'Go'},{element_token:newest+':1',role:'AXMenuItem',label:'About'},...(clicks?[{element_token:newest+':2',role:'AXStaticText',label:'Done',value:'Done'}]:[]),{element_token:newest+':3',role:'AXTextField',label:'Name',value:fieldValue}];
    const value={snapshot_id:newest,pid:args.pid,window_id:args.window_id,max_elements:args.max_elements,screenshot_scale:2,tree_markdown:'- [0] AXWindow',_note:'prefer elements',elements,returned_element_count:elements.length,screenshot_file_path:args.screenshot_out_file,screenshot_mime_type:'image/png'};
    return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
  }
  if(stale(args.element_token)) return {isError:true,content:[{type:'text',text:'element_token is stale; call get_window_state again to refresh'}]};
  if(request.params.name==='click'){ if(args.element_token==='refuse') return {isError:true,content:[{type:'text',text:'no such element in this snapshot'}]}; clicks+=1; const value={route:'accessibility',effect:'unverifiable',forwarded:args}; return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}; }
  if(request.params.name==='set_agent_cursor_motion'){ cursorCalls.push({session:args.session,glide_duration_ms:args.glide_duration_ms,dwell_after_click_ms:args.dwell_after_click_ms}); const value={motion:{glide_duration_ms:args.glide_duration_ms,dwell_after_click_ms:args.dwell_after_click_ms},session:args.session}; return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}; }
  if(request.params.name==='set_agent_cursor_enabled'){ cursorCalls.push({session:args.session,enabled:args.enabled}); const value={enabled:args.enabled,session:args.session}; return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}; }
  if(request.params.name==='get_config'){ const value={cursorCalls}; return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}; }
  if(request.params.name==='set_value'){ fieldValue=args.value; const value={effect:'unverifiable',route:'accessibility',forwarded:args}; return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}; }
  if(request.params.name==='invoke_menu'){ const value={effect:'invoked',path:args.path,forwarded:args}; return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}; }
  if(request.params.name==='zoom') return {content:[{type:'image',mimeType:'image/png',data:'aW1hZ2U='}],structuredContent:{pid:args.pid,window_id:args.window_id,screenshot_scale:4}};
  if(request.params.name==='hotkey'){ const dropped=args.keys.includes('x'); const value={effect:'unverifiable',keys:args.keys,delivery:{mode:args.delivery_mode??'background'},pid:args.pid,...(dropped?{escalation:{reason:'delivery_failed',target:'foreground'},route:'synthetic_events'}:{})}; return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}; }
  if(request.params.name==='list_apps'){ const value={apps:[{pid:1,active:true,name:'Other'},{pid:42,active:false,name:'Fixture'}]}; return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}; }
  if(request.params.name==='list_windows'){ const value={windows:[{pid:args.pid,window_id:7,z_index:1,is_on_screen:true},{pid:args.pid,window_id:8,title:'',bounds:{x:0,y:0,width:1352,height:30},is_on_screen:false},{pid:args.pid,window_id:9,title:'Downloads',bounds:{x:0,y:0,width:900,height:600},is_on_screen:true}]}; return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}; }
  if(request.params.name==='get_accessibility_tree'){ const value={pid:args.pid,elements:Array.from({length:4000},(_,index)=>({element_index:index,role:'AXStaticText',label:'Row '+index+' '+'description '.repeat(6)}))}; return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}; }
  return {content:[{type:'text',text:JSON.stringify(args)}]};
});
await server.connect(new StdioServerTransport());
`
const fixtureRoot = await mkdtemp(join(tmpdir(), "mako-computer-reconnect-"))
process.env.MAKO_CONTROL_ARTIFACTS = join(fixtureRoot, "artifacts")
const warnings: string[] = []
const originalWarn = console.warn
console.warn = (...values: unknown[]) => {
  warnings.push(values.map(String).join(" "))
}
const textBlocks = z.array(
  z.object({ type: z.string(), text: z.string().optional() })
)
const firstText = (content: CallToolResult["content"] | undefined) =>
  z.string().parse(textBlocks.parse(content)[0]?.text)
const exec = (client: Client, program: string) =>
  client.callTool({
    name: "mako_computer_exec",
    arguments: { source: program },
  })
try {
  for (const task of ["first", "second"]) {
    const marker = join(fixtureRoot, task)
    const failOnce = `import { existsSync, writeFileSync } from "node:fs"; const marker = ${JSON.stringify(marker)}; if (!existsSync(marker)) { writeFileSync(marker, "failed initialization"); process.exit(1); }\n`
    const server = createComputerToolsServer(
      {
        command: process.execPath,
        args: ["--input-type=module", "--eval", failOnce + source],
      },
      task,
      undefined,
      { surface: "driver" }
    )
    const client = new Client({ name: "computer-test", version: "1" })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(st)
      await client.connect(ct)
      assert.match(client.getInstructions() ?? "", /delivered_chars/)
      assert.match(client.getInstructions() ?? "", /invoke_menu/)
      assert.match(client.getInstructions() ?? "", /view\(target\)/)
      assert.match(client.getInstructions() ?? "", /act\('click'/)
      // A failed driver start is reported and retried on the next call.
      const failed = await client.callTool({
        name: "mako_computer_help",
        arguments: {},
      })
      assert.equal(failed.isError, true)
      assert.match(String(failed.structuredContent?.message), /closed/i)
      // The program tool's description carries the reference, read from the
      // live driver: helpers first, then every action with its return shape.
      const tools = await client.listTools()
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        "mako_computer_exec",
        "mako_computer_help",
        "mako_computer_status",
      ])
      const execDescription =
        tools.tools.find((tool) => tool.name === "mako_computer_exec")
          ?.description ?? ""
      assert.match(
        execDescription,
        /Helpers \(async, available in every program\):\n  view\(/
      )
      assert.match(execDescription, /\n  act\(action, args/)
      assert.match(
        execDescription,
        /\n  computer\.get_window_state\(\{pid, include_markdown\?, include_menu_bar\?\}\)  Native capture$/
      )
      const help = z
        .object({
          actions: z.array(
            z.object({ action: z.string(), signature: z.string() })
          ),
          routes: z.array(z.object({ route: z.string() })),
        })
        .parse(
          JSON.parse(
            firstText(
              (
                await client.callTool({
                  name: "mako_computer_help",
                  arguments: {},
                })
              ).content
            )
          )
        )
      assert.deepEqual(help.actions, [
        {
          action: "script",
          signature: "computer.script({language?, source, timeout_ms?})",
        },
        {
          action: "shell",
          signature: "computer.shell({command, cwd?, timeout_ms?})",
        },
        { action: "page_routes", signature: "computer.page_routes({})" },
        {
          action: "get_window_state",
          signature:
            "computer.get_window_state({pid, include_markdown?, include_menu_bar?})",
        },
      ])
      assert.deepEqual(
        help.routes.map((rung) => rung.route),
        BACKGROUND_INPUT_LADDER.map((rung) => rung.route)
      )
      const detail = z
        .object({
          action: z.literal("get_window_state"),
          inputSchema: z.object({
            properties: z.record(z.string(), z.json()),
            required: z.array(z.string()),
          }),
          annotations: z.object({ readOnlyHint: z.literal(true) }),
          notes: z.array(z.string()),
        })
        .parse(
          JSON.parse(
            firstText(
              (
                await client.callTool({
                  name: "mako_computer_help",
                  arguments: { tool: "get_window_state" },
                })
              ).content
            )
          )
        )
      assert.equal(detail.inputSchema.properties.session, undefined)
      assert.deepEqual(detail.inputSchema.required, ["pid"])
      assert.match(detail.notes.join(" "), /max_elements to 300/)
      const result = await exec(
        client,
        "return await computer.get_window_state({pid: 42, session: 'other-task'})"
      )
      assert.ok(!result.isError, JSON.stringify(result))
      // A program's result is the driver's data itself, with the image it
      // carried on `content`; the MCP envelope and the text echo are gone.
      const value = z
        .object({
          session: z.string(),
          pid: z.number(),
          screenshot_scale: z.number(),
          max_elements: z.number(),
          content: z.array(
            z.object({
              type: z.string(),
              data: z.string().optional(),
              mimeType: z.string().optional(),
            })
          ),
        })
        .strict()
        .parse(JSON.parse(firstText(result.content)))
      assert.match(value.session, new RegExp(`^mako-${task}-[0-9a-f]{8}$`))
      assert.equal(value.screenshot_scale, 2)
      assert.equal(value.pid, 42)
      assert.equal(value.max_elements, 300)
      assert.deepEqual(value.content, [
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      ])
    } finally {
      await client.close()
      await server.close()
    }
  }

  // The driver refuses an output path whose deepest existing ancestor is a
  // symbolic link (macOS `/tmp`), so the wrapper forwards the real ancestor.
  const real = join(fixtureRoot, "real")
  const link = join(fixtureRoot, "link")
  await mkdir(real)
  await symlink(real, link)
  const realRoot = await realpath(real)
  assert.equal(
    await canonicalDriverPath(join(link, "nested", "shot.png")),
    join(realRoot, "nested", "shot.png")
  )
  assert.equal(
    await canonicalDriverPath("captures/shot.png", link),
    join(realRoot, "captures", "shot.png")
  )
  assert.equal(
    await canonicalDriverPath("~/mako-missing-dir/shot.png"),
    join(await realpath(homedir()), "mako-missing-dir", "shot.png")
  )

  // Previews are posted to the host's control endpoint; capture them here.
  const observations: Array<{
    operation: string
    status: string
    image?: { data: string; mimeType: string }
  }> = []
  const browserCommands: unknown[] = []
  let browserOwnerReleases = 0
  const control = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8")
    })
    request.on("end", () => {
      if (request.url === "/browser/release-owner") {
        browserOwnerReleases++
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify({ ok: true, value: { released: 0, closed: 0 } })
          )
        return
      }
      const parsed = z.json().parse(JSON.parse(body))
      if (request.url === "/browser") {
        browserCommands.push(parsed)
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: true, value: { echo: parsed } }))
        return
      }
      observations.push(
        z
          .object({
            operation: z.string(),
            status: z.string(),
            image: z
              .object({ data: z.string(), mimeType: z.string() })
              .optional(),
          })
          .parse(parsed)
      )
      response.writeHead(200).end("{}")
    })
  })
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve))
  const port = z.object({ port: z.number() }).parse(control.address()).port
  process.env.MAKO_CONTROL_URL = `http://127.0.0.1:${port}/browser`
  process.env.MAKO_CONTROL_TOKEN = "fixture-token"
  const server = createComputerToolsServer(
    {
      command: process.execPath,
      args: ["--input-type=module", "--eval", driverSource],
    },
    "paths",
    undefined,
    { surface: "driver" }
  )
  const client = new Client({ name: "computer-test", version: "1" })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(st)
    await client.connect(ct)
    const listed = await client.listTools()
    const catalogBytes = Buffer.byteLength(JSON.stringify(listed.tools))
    assert.ok(catalogBytes < 8_000, `tool catalog is ${catalogBytes} bytes`)
    assert.match(
      listed.tools.find((tool) => tool.name === "mako_computer_exec")
        ?.description ?? "",
      /\n  computer\.get_window_state\(\{pid, window_id, element_token\?, snapshot_id\?, max_elements\?, screenshot_out_file\?, delivery_mode\?, include_markdown\?, include_menu_bar\?\}\) → \{snapshot_id, pid, window_id, screenshot_scale\}  Capture\.\n  computer\.click\(/
    )
    const statusSchema = z.object({
      available: z.literal(true),
      driverTools: z.literal(12),
      agentCursor: z.string(),
      program: z.literal("mako_computer_exec"),
      helpers: z.array(z.string()),
      makoActions: z.array(z.string()),
      browser: z.string(),
      inputRoutes: z.object({
        default: z.literal("background"),
        order: z.array(z.string()),
        foreground: z.literal("explicit-preflight"),
        automaticEscalation: z.literal(false),
      }),
      frontingEvents: z.number(),
      pageRoutes: z.record(z.string(), z.json()),
      artifacts: z.string(),
    })
    const readStatus = async () =>
      statusSchema.parse(
        JSON.parse(
          firstText(
            (
              await client.callTool({
                name: "mako_computer_status",
                arguments: {},
              })
            ).content
          )
        )
      )
    const status = await readStatus()
    z.object({}).parse(
      JSON.parse(
        firstText(
          (
            await client.callTool({
              name: "mako_computer_status",
              arguments: {},
            })
          ).content
        )
      )
    )
    assert.deepEqual(status.helpers, [
      "view",
      "act",
      "until",
      "expect",
      "token",
      "windows",
      "fill",
      "submit",
      "routes",
      "route",
    ])
    assert.deepEqual(status.makoActions, ["script", "shell", "page_routes"])
    assert.match(status.browser, /available in programs/)
    assert.equal(status.frontingEvents, 0)
    assert.deepEqual(status.pageRoutes, {})
    assert.equal(status.inputRoutes.order[0], "accessibility")
    assert.equal(status.inputRoutes.order.at(-1), "foreground")
    assert.ok(status.artifacts.startsWith(join(fixtureRoot, "artifacts")))
    const hotkeyHelp = z
      .object({
        signature: z.string(),
        notes: z.array(z.string()),
        inputSchema: z.object({
          properties: z.object({
            pid: z.object({ minimum: z.number(), maximum: z.number() }),
          }),
        }),
      })
      .parse(
        JSON.parse(
          firstText(
            (
              await client.callTool({
                name: "mako_computer_help",
                arguments: { tool: "hotkey" },
              })
            ).content
          )
        )
      )
    assert.match(hotkeyHelp.signature, /^computer\.hotkey\(\{/)
    assert.match(hotkeyHelp.notes.join("\n"), /never escalates automatically/)
    assert.match(hotkeyHelp.notes.join("\n"), /invoke_menu/)
    assert.match(hotkeyHelp.signature, /foreground\?, force\?\}\)$/)
    assert.equal(
      hotkeyHelp.inputSchema.properties.pid.minimum,
      -2_147_483_648,
      "driver formats are published as ranges"
    )
    // A removed per-action tool is refused by name with the way in.
    const legacy = await client.callTool({
      name: "mako_computer_click",
      arguments: { pid: 42 },
    })
    assert.equal(legacy.isError, true)
    assert.match(
      String(legacy.structuredContent?.message),
      /mako_computer_exec/
    )

    const shot = join(link, "nested", "shot.png")
    await mkdir(join(realRoot, "nested"))
    const pixels = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=",
      "base64"
    )
    await writeFile(join(realRoot, "nested", "shot.png"), pixels)
    const result = await exec(
      client,
      `return await computer.get_window_state({pid: 42, window_id: 7, screenshot_out_file: ${JSON.stringify(shot)}})`
    )
    assert.ok(!result.isError, JSON.stringify(result))
    const captured = z
      .object({
        snapshot_id: z.string(),
        max_elements: z.number(),
        screenshot_file_path: z.string(),
        tree_markdown: z.string().optional(),
        _note: z.string().optional(),
        content: z.array(z.json()).optional(),
        elements: z.array(z.object({ role: z.string() })),
        returned_element_count: z.number(),
        menu_bar_elements_omitted: z.number(),
      })
      .parse(JSON.parse(firstText(result.content)))
    assert.equal(captured.max_elements, 300)
    assert.equal(
      captured.screenshot_file_path,
      join(realRoot, "nested", "shot.png")
    )
    assert.equal(captured.tree_markdown, undefined)
    assert.equal(captured._note, undefined)
    assert.equal(captured.content, undefined, "no image, no content")
    // The application's menu bar is not part of a window state.
    assert.deepEqual(
      captured.elements.map((element) => element.role),
      ["AXButton", "AXTextField"]
    )
    assert.equal(captured.returned_element_count, 2)
    assert.equal(captured.menu_bar_elements_omitted, 1)
    const verbose = await exec(
      client,
      "return await computer.get_window_state({pid: 42, window_id: 7, max_elements: 5, include_markdown: true, include_menu_bar: true})"
    )
    const verboseState = z
      .object({
        tree_markdown: z.string(),
        max_elements: z.number(),
        elements: z.array(z.json()),
        include_menu_bar: z.boolean().optional(),
      })
      .parse(JSON.parse(firstText(verbose.content)))
    assert.equal(verboseState.max_elements, 5)
    assert.equal(verboseState.elements.length, 3)
    assert.equal(
      verboseState.include_menu_bar,
      undefined,
      "Mako's flags never reach the driver"
    )

    // list_windows rows carry a kind; windows() drops the helper strips and
    // puts the titled document before the untitled unknown window.
    const kinds = await exec(
      client,
      "const listed = await computer.list_windows({pid: 42}); const documents = await windows(42); return {kinds: listed.windows.map(w => [w.window_id, w.kind]), documents: documents.map(w => w.window_id)}"
    )
    assert.deepEqual(JSON.parse(firstText(kinds.content)), {
      kinds: [
        [7, "unknown"],
        [8, "helper"],
        [9, "document"],
      ],
      documents: [9, 7],
    })

    // view reads the window as lines; act performs a step and returns what
    // changed; expect stops a program on a screen it did not assume.
    const stepped = await exec(
      client,
      "const lines = await view({pid: 42, window_id: 7}); const step = await act('click', {element_token: lines[0].split(' ')[0]}, {settle: 10, wait: 50}); await expect(l => l.some(line => /Done/.test(line)), 'Done never showed'); let failed; try { await expect(l => l.length === 99, 'Wrong screen') } catch (error) { failed = error.message.split('\\n')[0] } return {lines, step, failed, target: state.target}"
    )
    assert.ok(!stepped.isError, JSON.stringify(stepped))
    const steppedResult = z
      .object({
        lines: z.array(z.string()),
        step: z.object({
          action: z.string(),
          result: z.record(z.string(), z.json()),
          added: z.array(z.string()),
          removed: z.array(z.string()),
          unchanged: z.number(),
        }),
        failed: z.string(),
        target: z.object({ pid: z.number(), window_id: z.number() }),
      })
      .parse(JSON.parse(firstText(stepped.content)))
    assert.deepEqual(
      steppedResult.lines.map((line) => line.replace(/^s[0-9a-f]{8}/, "s*")),
      ['s*:0 Button "Go"', 's*:3 TextField "Name"']
    )
    assert.equal(steppedResult.step.action, "click")
    assert.deepEqual(steppedResult.step.result, {
      route: "accessibility",
      effect: "unverifiable",
    })
    assert.deepEqual(
      steppedResult.step.added.map((line) =>
        line.replace(/^s[0-9a-f]{8}/, "s*")
      ),
      ['s*:2 StaticText "Done"']
    )
    assert.deepEqual(steppedResult.step.removed, [])
    assert.equal(steppedResult.step.unchanged, 2)
    assert.equal(steppedResult.failed, "Wrong screen. The window shows:")
    assert.deepEqual(steppedResult.target, { pid: 42, window_id: 7 })

    // fill returns its exact read-back view. The next action takes a token
    // from that view; Mako never guesses that an older role/label still names
    // the same control.
    const composed = await exec(
      client,
      "const lines = await view({pid: 42, window_id: 7}); const field = lines.find(l => /TextField/.test(l)).split(' ')[0]; const oldButton = lines.find(l => /Button \"Go\"/.test(l)).split(' ')[0]; const written = await fill(field, 'fresh'); const button = written.view.find(l => /Button \"Go\"/.test(l)).split(' ')[0]; const clicked = await act('click', {element_token: button}, {settle: 10, wait: 50}); let stale; try { await computer.click({element_token: oldButton}) } catch (error) { stale = error.message } return {confirmed: written.confirmed, oldButton, button, clicked: clicked.result, stale}"
    )
    assert.ok(!composed.isError, JSON.stringify(composed))
    const composedResult = z
      .object({
        confirmed: z.boolean(),
        oldButton: z.string(),
        button: z.string(),
        clicked: z.object({ route: z.string() }).loose(),
        stale: z.string(),
      })
      .parse(JSON.parse(firstText(composed.content)))
    assert.equal(composedResult.confirmed, true)
    assert.notEqual(composedResult.oldButton, composedResult.button)
    assert.equal(composedResult.clicked.route, "accessibility")
    assert.match(composedResult.stale, /stale/)

    // fill writes through set_value and reads the control back by role and
    // label; submit confirms; routes decides before any round trip.
    const filled = await exec(
      client,
      "const lines = await view({pid: 42, window_id: 7}); const field = lines.find(l => /TextField/.test(l)).split(' ')[0]; const written = await fill(field, 'Ada', {wait: 300}); const current = written.view.find(l => /TextField/.test(l)).split(' ')[0]; const sent = await submit(current); const verdicts = await routes(); return {written, sent: sent.route, verdicts}"
    )
    assert.ok(!filled.isError, JSON.stringify(filled))
    const filledResult = z
      .object({
        written: z.object({
          action: z.literal("fill"),
          route: z.literal("set_value"),
          confirmed: z.literal(true),
          line: z.string(),
          view: z.array(z.string()),
        }),
        sent: z.literal("confirm"),
        verdicts: z.object({
          target: z.object({
            pid: z.number(),
            window_id: z.number(),
          }),
          routes: z.array(
            z.object({
              route: z.string(),
              status: z.string(),
              reason: z.string().optional(),
            })
          ),
        }),
      })
      .parse(JSON.parse(firstText(filled.content)))
    assert.match(filledResult.written.line, /TextField "Name" ="Ada"$/)
    assert.deepEqual(filledResult.verdicts.target, {
      pid: 42,
      window_id: 7,
    })
    const keyboardCapability = filledResult.verdicts.routes.find(
      (route) => route.route === "pid-keyboard"
    )
    assert.equal(keyboardCapability?.status, "unavailable")
    assert.match(keyboardCapability?.reason ?? "", /2 document windows/)
    assert.equal(
      filledResult.verdicts.routes.find((route) => route.route === "page")
        ?.status,
      "unavailable"
    )
    // A refused driver action is a thrown error inside the program.
    const refused = await exec(
      client,
      "try { await computer.click({pid: 42, element_token: 'refuse'}); return 'ran' } catch (error) { return error.message }"
    )
    assert.equal(
      JSON.parse(firstText(refused.content)),
      "no such element in this snapshot"
    )

    // A chain: observe, act by token (the snapshot's pid and window follow),
    // and return only what was decided from.
    const executed = await exec(
      client,
      "const view = await computer.get_window_state({pid: 42, window_id: 7}); state.token = view.elements[0].element_token; const clicked = await computer.click({element_token: state.token}); return {snapshot: view.snapshot_id, click: clicked.forwarded}"
    )
    const executedResult = z
      .object({
        snapshot: z.string(),
        click: z.object({
          pid: z.number(),
          window_id: z.number(),
          session: z.string(),
        }),
      })
      .parse(JSON.parse(firstText(executed.content)))
    assert.match(executedResult.snapshot, /^s[0-9a-f]{8}$/)
    assert.equal(executedResult.click.pid, 42)
    assert.equal(executedResult.click.window_id, 7)
    assert.match(executedResult.click.session, /^mako-paths-[0-9a-f]{8}$/)
    // The driver's animated agent cursor is quieted once per session (the
    // awaited glide made every action on a new element 2.5 s), before the
    // first call that names the session, and never toggled again.
    const cursor = z
      .object({
        cursorCalls: z.array(
          z.union([
            z.object({ session: z.string(), enabled: z.boolean() }),
            z.object({
              session: z.string(),
              glide_duration_ms: z.number(),
              dwell_after_click_ms: z.number(),
            }),
          ])
        ),
      })
      .parse(
        JSON.parse(
          firstText(
            (await exec(client, "return await computer.get_config({})")).content
          )
        )
      )
    assert.deepEqual(cursor.cursorCalls, [
      {
        session: executedResult.click.session,
        glide_duration_ms: 1,
        dwell_after_click_ms: 0,
      },
      { session: executedResult.click.session, enabled: false },
    ])
    assert.ok(
      Buffer.byteLength(JSON.stringify(executed.content)) < 400,
      "the chain returns its decision, not the tree"
    )
    // An explicit pid wins over the snapshot's; state survives between runs.
    const explicit = await exec(
      client,
      "const clicked = await computer.click({element_token: state.token, pid: 99}); return clicked.forwarded.pid"
    )
    assert.equal(JSON.parse(firstText(explicit.content)), 99)

    // emitImage carries the snapshot receipt beside the pixels.
    const emitted = await exec(
      client,
      "const zoom = await computer.zoom({pid:42,window_id:7}); emitImage(zoom)"
    )
    const emittedContent = z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), text: z.string() }),
          z.object({
            type: z.literal("image"),
            data: z.string(),
            mimeType: z.string(),
          }),
        ])
      )
      .parse(emitted.content)
    assert.deepEqual(JSON.parse(firstText(emittedContent)), {
      pid: 42,
      window_id: 7,
      screenshot_scale: 4,
    })
    assert.equal(emittedContent[1]?.type, "image")

    // A background Cmd chord is refused before the driver is asked; force
    // posts it, and the flag never reaches the driver.
    const chord = await exec(
      client,
      "try { await computer.hotkey({pid: 42, window_id: 7, keys: ['cmd', 'a']}); return 'posted' } catch (error) { return error.message }"
    )
    assert.match(
      String(JSON.parse(firstText(chord.content))),
      /menu key equivalent.*Nothing was posted/
    )
    const forced = await exec(
      client,
      "return await computer.hotkey({pid: 42, window_id: 7, keys: ['cmd', 'a'], force: true})"
    )
    assert.ok(!forced.isError, JSON.stringify(forced))
    const forcedResult = z
      .object({ keys: z.array(z.string()), force: z.boolean().optional() })
      .loose()
      .parse(JSON.parse(firstText(forced.content)))
    assert.deepEqual(forcedResult.keys, ["cmd", "a"])
    assert.equal(forcedResult.force, undefined, "Mako's flag is stripped")

    // A background hotkey goes through unchanged; a result the driver could
    // not confirm carries Mako's reading and the routes that can do the job.
    const combo = await exec(
      client,
      "return await computer.hotkey({pid: 42, window_id: 7, keys: ['shift', 'left']})"
    )
    assert.ok(!combo.isError, JSON.stringify(combo))
    const comboSchema = z
      .object({
        effect: z.literal("unverifiable"),
        delivery: z.object({ mode: z.literal("background") }),
        mako_routes: z.object({
          status: z.enum(["unverifiable", "unconfirmed"]),
          reason: z.string(),
          routes: z.string(),
        }),
        escalation: z.object({ reason: z.string() }).strict().optional(),
        content: z.array(z.json()).optional(),
      })
      .loose()
    const comboResult = comboSchema.parse(JSON.parse(firstText(combo.content)))
    assert.equal(comboResult.mako_routes.status, "unverifiable")
    assert.match(comboResult.mako_routes.routes, /invoke_menu/)
    // The program sees the structured data once: no envelope, no text echo.
    assert.equal(comboResult.content, undefined)
    // The driver's delivery_failed escalation becomes an unconfirmed verdict
    // with the routes that work; its foreground nudge is stripped to the reason.
    const dropped = comboSchema.parse(
      JSON.parse(
        firstText(
          (
            await exec(
              client,
              "return await computer.hotkey({pid: 42, window_id: 7, keys: ['shift', 'x']})"
            )
          ).content
        )
      )
    )
    assert.equal(dropped.mako_routes.status, "unconfirmed")
    assert.match(dropped.mako_routes.reason, /Read the field back/)
    assert.match(dropped.mako_routes.routes, /set_value/)
    assert.deepEqual(dropped.escalation, { reason: "delivery_failed" })

    // Foreground delivery is declared with foreground: true, and then still
    // meets Mako's preflight: the fixture's active app is pid 1, so pid 42
    // is refused before dispatch.
    const undeclared = await exec(
      client,
      "return await computer.hotkey({pid: 42, window_id: 7, keys: ['cmd', 'z'], delivery_mode: 'foreground'})"
    )
    assert.equal(undeclared.isError, true)
    assert.match(
      String(undeclared.structuredContent?.message),
      /Pass foreground: true/
    )
    const foreground = await exec(
      client,
      "return await computer.hotkey({pid: 42, window_id: 7, keys: ['cmd', 'z'], delivery_mode: 'foreground', foreground: true})"
    )
    assert.equal(foreground.isError, true)
    assert.match(String(foreground.structuredContent?.message), /not frontmost/)
    // The refusal is a thrown error inside the program, so a program can
    // catch it and take a background route instead.
    const recovered = await exec(
      client,
      "try { await computer.hotkey({pid: 42, window_id: 7, keys: ['cmd', 'z'], delivery_mode: 'foreground', foreground: true}); return 'sent' } catch (error) { return {refused: error.message.includes('frontmost')} }"
    )
    assert.deepEqual(JSON.parse(firstText(recovered.content)), {
      refused: true,
    })

    // Fronting is declared and counted: invoke_menu without the flag is
    // refused before the driver; with it the result reports fronted.ms.
    const menuRefused = await exec(
      client,
      "try { await computer.invoke_menu({pid: 42, window_id: 7, path: ['Edit', 'Select All']}); return 'invoked' } catch (error) { return error.message }"
    )
    assert.match(
      String(JSON.parse(firstText(menuRefused.content))),
      /takes the user's screen.*Pass foreground: true/
    )
    const menu = await exec(
      client,
      "return await computer.invoke_menu({pid: 42, window_id: 7, path: ['Edit', 'Select All'], foreground: true})"
    )
    assert.ok(!menu.isError, JSON.stringify(menu))
    const menuResult = z
      .object({
        effect: z.literal("invoked"),
        fronted: z.object({ pid: z.literal(42), ms: z.number() }),
        forwarded: z.object({ foreground: z.boolean().optional() }).loose(),
      })
      .loose()
      .parse(JSON.parse(firstText(menu.content)))
    assert.equal(menuResult.forwarded.foreground, undefined)
    assert.equal((await readStatus()).frontingEvents, 1)

    // Mako's own actions: a shell command and, on macOS, a JXA script, each
    // returning the command's output as data.
    const shellRun = await exec(
      client,
      "return await computer.shell({command: 'printf hi; printf err 1>&2; exit 3'})"
    )
    assert.ok(!shellRun.isError, JSON.stringify(shellRun))
    assert.deepEqual(
      z
        .object({
          stdout: z.string(),
          stderr: z.string(),
          exit_code: z.number(),
          timed_out: z.boolean(),
          truncated: z.boolean(),
        })
        .parse(JSON.parse(firstText(shellRun.content))),
      {
        stdout: "hi",
        stderr: "err",
        exit_code: 3,
        timed_out: false,
        truncated: false,
      }
    )
    const slow = await exec(
      client,
      "return await computer.shell({command: 'sleep 5', timeout_ms: 200})"
    )
    assert.equal(
      z
        .object({ timed_out: z.boolean() })
        .loose()
        .parse(JSON.parse(firstText(slow.content))).timed_out,
      true
    )
    if (process.platform === "darwin") {
      const script = await exec(
        client,
        "return await computer.script({language: 'jxa', source: '(function(){ return 6 * 7 })()'})"
      )
      assert.ok(!script.isError, JSON.stringify(script))
      const scriptResult = z
        .object({ stdout: z.string(), exit_code: z.number() })
        .loose()
        .parse(JSON.parse(firstText(script.content)))
      assert.equal(scriptResult.stdout, "42\n")
      assert.equal(scriptResult.exit_code, 0)
    }

    // The browser object rides on the host's browser control: a valid
    // command reaches it, an invalid one is refused before dispatch.
    const browserCommandCount = browserCommands.length
    const browsed = await exec(
      client,
      "const status = await browser.status({}); let refused; try { await browser.click({}) } catch (error) { refused = error.message } return {status, refused}"
    )
    assert.ok(!browsed.isError, JSON.stringify(browsed))
    const browsedResult = z
      .object({
        status: z.object({ echo: z.object({ action: z.literal("status") }) }),
        refused: z.string(),
      })
      .parse(JSON.parse(firstText(browsed.content)))
    assert.match(browsedResult.refused, /Invalid arguments for browser\.click/)
    assert.equal(browserCommands.length, browserCommandCount + 1)
    assert.deepEqual(browserCommands.at(-1), { action: "status" })

    // A huge tree returned from a program is written whole and outlined.
    const huge = await exec(
      client,
      "return await computer.get_accessibility_tree({pid: 42})"
    )
    assert.ok(!huge.isError, JSON.stringify(huge).slice(0, 300))
    const receipt = z
      .object({
        artifact: z.literal(true),
        kind: z.literal("json"),
        path: z.string(),
        bytes: z.number(),
        outline: z.object({
          type: z.literal("object"),
          keys: z.array(
            z.object({ name: z.string(), type: z.string(), bytes: z.number() })
          ),
        }),
      })
      .parse(JSON.parse(firstText(huge.content)))
    assert.ok(receipt.bytes > 200_000)
    assert.ok(
      receipt.path.startsWith(join(fixtureRoot, "artifacts", "computer"))
    )
    const elements = receipt.outline.keys.find((key) => key.name === "elements")
    assert.equal(elements?.type, "array")
    const saved = z
      .object({ elements: z.array(z.json()) })
      .parse(JSON.parse(await readFile(receipt.path, "utf8")))
    assert.equal(saved.elements.length, 4000, "nothing was cut")
    // The same tree filtered inside the program stays inline.
    const filtered = await exec(
      client,
      "const tree = await computer.get_accessibility_tree({pid: 42}); return tree.elements.filter(e => e.label.startsWith('Row 39')).map(e => e.element_index)"
    )
    assert.equal(
      z.array(z.number()).parse(JSON.parse(firstText(filtered.content))).length,
      111
    )

    for (let attempt = 0; attempt < 100; attempt++) {
      if (observations.some((entry) => entry.image)) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const preview = observations.find(
      (entry) =>
        entry.operation === "get_window_state" && entry.status === "observed"
    )
    assert.ok(preview?.image, "the file capture reaches the preview")
    assert.equal(preview.image.mimeType, "image/png")
    assert.equal(preview.image.data, pixels.toString("base64"))
  } finally {
    await client.close()
    await server.close()
    assert.ok(browserOwnerReleases > 0)
    control.close()
    delete process.env.MAKO_CONTROL_URL
    delete process.env.MAKO_CONTROL_TOKEN
  }
  assert.deepEqual(
    warnings.filter((line) => /unknown format/i.test(line)),
    [],
    "driver integer formats compile without validator warnings"
  )
} finally {
  console.warn = originalWarn
  await rm(fixtureRoot, { recursive: true, force: true })
}

let unifiedPageValue = ""
const unifiedPageTarget = {
  browser: "fixture-browser",
  tab: "fixture-tab",
  generation: "fixture-generation",
  lease: "fixture-lease",
}
const unifiedServer = createComputerToolsServer(
  {
    command: process.execPath,
    args: ["--input-type=module", "--eval", driverSource],
  },
  "unified-control",
  undefined,
  {
    surface: "control",
    browserCall: async (command) => {
      if (command.action === "status")
        return [{ id: "fixture-browser", connection: { status: "connected" } }]
      if (command.action === "tabs")
        return [{ id: "fixture-tab", title: "Fixture", url: "about:blank" }]
      if (command.action === "open" || command.action === "select")
        return unifiedPageTarget
      if (command.action === "observe")
        return {
          observation: `page-${unifiedPageValue || "empty"}`,
          nodes: [
            {
              depth: 0,
              role: "RootWebArea",
              name: "Fixture settings",
            },
            {
              depth: 1,
              role: "region",
              name: "Account",
            },
            {
              ref: "abc123:1",
              depth: 2,
              role: "textbox",
              name: "Page proof",
              value: unifiedPageValue,
            },
          ],
          viewport: null,
          matched: 1,
          nextOffset: null,
          omitted: 0,
        }
      if (command.action === "type") {
        unifiedPageValue = command.text
        return { typed: true }
      }
      if (command.action === "cdp")
        return { result: { value: command.method } }
      return { echo: command }
    },
  }
)
const unifiedClient = new Client({ name: "control-test", version: "1" })
const [unifiedClientTransport, unifiedServerTransport] =
  InMemoryTransport.createLinkedPair()
try {
  await unifiedServer.connect(unifiedServerTransport)
  await unifiedClient.connect(unifiedClientTransport)
  assert.match(unifiedClient.getInstructions() ?? "", /provider-neutral code API/)
  const tools = await unifiedClient.listTools()
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["mako_control_exec", "mako_control_help", "mako_control_status"]
  )
  const help = JSON.parse(
    firstText(
      (
        await unifiedClient.callTool({
          name: "mako_control_help",
          arguments: {},
        })
      ).content
    )
  )
  assert.deepEqual(
    z
      .object({ actions: z.array(z.object({ action: z.string() })) })
      .parse(help)
      .actions.map((action) => action.action),
    ["targets", "observe", "act", "wait", "events", "advanced"]
  )
  const protocolHelp = JSON.parse(
    firstText(
      (
        await unifiedClient.callTool({
          name: "mako_control_help",
          arguments: { domain: "Runtime", method: "evaluate" },
        })
      ).content
    )
  )
  assert.equal(protocolHelp.command.name, "evaluate")
  const routed = await unifiedClient.callTool({
    name: "mako_control_exec",
    arguments: {
      source: `const target = {kind: 'window', pid: 42, window_id: 7};
const before = await control.observe({target, interactive: true});
const ref = control.ref(before.lines.find(line => /TextField "Name"/.test(line)));
return control.act({target, operation: {kind: 'set-text', ref, text: 'unified'}});`,
    },
  })
  assert.ok(!routed.isError, JSON.stringify(routed))
  const result = z
    .object({
      dispatched: z.literal(true),
      plan: z.object({
        route: z.literal("accessibility"),
        topology: z.literal("none"),
      }),
      receipt: z.object({
        outcome: z.literal("confirmed"),
        verification: z.object({ status: z.literal("confirmed") }),
      }),
      observation: z.object({
        target: z.object({ kind: z.literal("window") }).loose(),
        lines: z.array(z.string()),
      }),
    })
    .parse(JSON.parse(firstText(routed.content)))
  assert.ok(
    result.observation.lines.some((line) => line.includes('="unified"'))
  )
  const crossTarget = await unifiedClient.callTool({
    name: "mako_control_exec",
    arguments: {
      source: `const observed = await control.observe({target:{kind:'window',pid:42,window_id:7},interactive:true});
const ref = control.ref(observed.lines[0]);
return control.act({target:{kind:'window',pid:42,window_id:9},operation:{kind:'activate',ref}});`,
    },
  })
  assert.equal(crossTarget.isError, true)
  assert.match(
    String(crossTarget.structuredContent?.message),
    /not from this target's latest observation/
  )
  const pageRun = await unifiedClient.callTool({
    name: "mako_control_exec",
    arguments: {
      source: `const target={kind:'page',...${JSON.stringify(unifiedPageTarget)}};
const observed=await control.observe({target,interactive:true});
const ref=control.ref(observed.lines.find(line=>line.includes('Page proof')));
return control.act({target,operation:{kind:'set-text',ref,text:'page value'}});`,
    },
  })
  assert.ok(!pageRun.isError, JSON.stringify(pageRun))
  const pageResult = z
    .object({
      plan: z.object({ route: z.literal("page") }),
      receipt: z.object({ outcome: z.literal("confirmed") }),
      observation: z.object({ lines: z.array(z.string()) }),
    })
    .parse(JSON.parse(firstText(pageRun.content)))
  assert.ok(
    pageResult.observation.lines.some((line) =>
      line.includes('="page value"')
    )
  )
  const pageHelpersRun = await unifiedClient.callTool({
    name: "mako_control_exec",
    arguments: {
      source: `const target=await page.open({browser:'fixture-browser'});
const observed=await page.observe(target);
const selected=page.select(observed,{roles:['textbox'],text:'proof'});
const protocol=await page.cdp(target,'Runtime.evaluate',{expression:'document.title'});
return {target,lines:page.lines(selected),selection:{matched:selected.matched,context:selected.context},protocol};`,
    },
  })
  assert.ok(!pageHelpersRun.isError, JSON.stringify(pageHelpersRun))
  const pageHelpersResult = z
    .object({
      target: z.object({ kind: z.literal("page") }).loose(),
      lines: z.array(z.string()),
      selection: z.object({
        matched: z.literal(1),
        context: z.literal(2),
      }),
      protocol: z.object({
        result: z.object({ value: z.literal("Runtime.evaluate") }),
      }),
    })
    .parse(JSON.parse(firstText(pageHelpersRun.content)))
  assert.match(pageHelpersResult.lines.at(-1) ?? "", /textbox "Page proof"/)
  const backgroundRefusals = await unifiedClient.callTool({
    name: "mako_control_exec",
    arguments: {
      source: `const hidden=await control.act({target:{kind:'window',pid:42,window_id:8},operation:{kind:'pointer',at:{x:2,y:2}}});
const chord=await control.act({target:{kind:'window',pid:42,window_id:7},operation:{kind:'press-key',key:'a',modifiers:['Meta']}});
return {hidden:hidden.plan.status,chord:chord.plan.status};`,
    },
  })
  assert.deepEqual(JSON.parse(firstText(backgroundRefusals.content)), {
    hidden: "foreground-required",
    chord: "foreground-required",
  })
} finally {
  await unifiedClient.close()
  await unifiedServer.close()
}

const guardDriverSource = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server=new Server({name:'guard-fixture',version:'1'},{capabilities:{tools:{}}});
const target={session:{type:'string'},pid:{type:'integer'},window_id:{type:'integer'},element_token:{type:'string'},max_elements:{type:'integer'}};
server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[
  {name:'get_window_state',inputSchema:{type:'object',properties:target,required:['session','pid','window_id']}},
  {name:'click',inputSchema:{type:'object',properties:target,required:['session','element_token']}},
  {name:'list_windows',inputSchema:{type:'object',properties:{session:{type:'string'},pid:{type:'integer'}},required:['session','pid']}}
]}));
let opened=false;
server.setRequestHandler(CallToolRequestSchema,request=>{
  const args=request.params.arguments;
  if(request.params.name==='get_window_state'){
    const value={snapshot_id:'s00000001',pid:args.pid,window_id:args.window_id,elements:[{element_token:'s00000001:0',role:'AXButton',label:'Open later'}]};
    return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
  }
  if(request.params.name==='click'){
    setTimeout(()=>{opened=true},60);
    const value={route:'accessibility',effect:'unverifiable'};
    return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
  }
  const windows=[{window_id:7,title:'Main',is_on_screen:true},...(opened?[{window_id:9,title:'Late',is_on_screen:true}]:[])];
  const value={windows};
  return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
});
await server.connect(new StdioServerTransport());`
const previousGuard = process.env.MAKO_CONTROL_ASYNC_GUARD
process.env.MAKO_CONTROL_ASYNC_GUARD = "1"
const guardServer = createComputerToolsServer(
  {
    command: process.execPath,
    args: ["--input-type=module", "--eval", guardDriverSource],
  },
  "guard-control",
  undefined,
  { surface: "control" }
)
const guardClient = new Client({ name: "guard-test", version: "1" })
const [guardClientTransport, guardServerTransport] =
  InMemoryTransport.createLinkedPair()
try {
  await guardServer.connect(guardServerTransport)
  await guardClient.connect(guardClientTransport)
  const acted = await guardClient.callTool({
    name: "mako_control_exec",
    arguments: {
      source: `const target={kind:'window',pid:42,window_id:7};
const observed=await control.observe({target,interactive:true});
const ref=control.ref(observed.lines[0]);
return control.act({target,operation:{kind:'activate',ref}});`,
    },
  })
  const actedValue = z
    .object({
      guard: z.object({
        status: z.literal("watching"),
        action_id: z.string(),
      }),
    })
    .parse(JSON.parse(firstText(acted.content)))
  await new Promise((resolve) => setTimeout(resolve, 250))
  const events = await guardClient.callTool({
    name: "mako_control_exec",
    arguments: {
      source:
        "return control.events({target:{kind:'window',pid:42,window_id:7},after:0})",
    },
  })
  const eventValue = z
    .object({
      events: z.array(
        z.object({
          kind: z.string(),
          detail: z.object({
            action_id: z.string(),
            opened: z.array(z.number()).optional(),
          }),
        })
      ),
    })
    .parse(JSON.parse(firstText(events.content)))
  assert.ok(
    eventValue.events.some(
      (event) =>
        event.kind === "topology" &&
        event.detail.action_id === actedValue.guard.action_id &&
        event.detail.opened?.includes(9)
    ),
    "a late popup is emitted after the verified action returns"
  )
} finally {
  await guardClient.close()
  await guardServer.close()
  if (previousGuard === undefined) delete process.env.MAKO_CONTROL_ASYNC_GUARD
  else process.env.MAKO_CONTROL_ASYNC_GUARD = previousGuard
}
console.log(
  "Computer MCP: driver-adapter regression and unified three-tool program surfaces, host-routed closed operations with receipts, results as data, target-bound refs, compact observations, background policy, browser lending, artifact receipts, previews and clean driver schemas verified"
)
