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
  {name:'zoom',description:'Zoom',inputSchema:{type:'object',properties:target,required:['session','pid','window_id']}}
]}));
let clicks=0;
server.setRequestHandler(CallToolRequestSchema,async request=>{
  const args=request.params.arguments;
  if(request.params.name==='get_window_state'){
    const elements=[{element_token:'s0000000a:0',role:'AXButton',label:'Go'},{element_token:'s0000000a:1',role:'AXMenuItem',label:'About'},...(clicks?[{element_token:'s0000000a:2',role:'AXStaticText',label:'Done',value:'Done'}]:[])];
    const value={snapshot_id:'s0000000a',pid:args.pid,window_id:args.window_id,max_elements:args.max_elements,screenshot_scale:2,tree_markdown:'- [0] AXWindow',_note:'prefer elements',elements,returned_element_count:elements.length,screenshot_file_path:args.screenshot_out_file,screenshot_mime_type:'image/png'};
    return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
  }
  if(request.params.name==='click'){ if(args.element_token==='refuse') return {isError:true,content:[{type:'text',text:'no such element in this snapshot'}]}; clicks+=1; }
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
      task
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
      assert.match(execDescription, /Helpers \(async, available in every program\):\n  view\(/)
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
  const control = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8")
    })
    request.on("end", () => {
      observations.push(
        z
          .object({
            operation: z.string(),
            status: z.string(),
            image: z
              .object({ data: z.string(), mimeType: z.string() })
              .optional(),
          })
          .parse(JSON.parse(body))
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
    "paths"
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
    const status = z
      .object({
        available: z.literal(true),
        driverTools: z.literal(7),
        program: z.literal("mako_computer_exec"),
        helpers: z.array(z.string()),
        inputRoutes: z.object({
          default: z.literal("background"),
          order: z.array(z.string()),
          foreground: z.literal("explicit-preflight"),
          automaticEscalation: z.literal(false),
        }),
        artifacts: z.string(),
      })
      .parse(
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
    assert.deepEqual(status.helpers, ["view", "act", "until", "expect", "windows"])
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
      ["AXButton"]
    )
    assert.equal(captured.returned_element_count, 1)
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
    assert.equal(verboseState.elements.length, 2)
    assert.equal(
      verboseState.include_menu_bar,
      undefined,
      "Mako's flags never reach the driver"
    )

    // list_windows rows carry a kind, and windows() drops the helper strips.
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
      documents: [7, 9],
    })

    // view reads the window as lines; act performs a step and returns what
    // changed; expect stops a program on a screen it did not assume.
    const stepped = await exec(
      client,
      "const lines = await view({pid: 42, window_id: 7}); const step = await act('click', {element_token: lines[0].split(' ')[0]}, {settle: 10}); await expect(l => l.some(line => /Done/.test(line)), 'Done never showed'); let failed; try { await expect(l => l.length === 99, 'Wrong screen') } catch (error) { failed = error.message.split('\\n')[0] } return {lines, step, failed, target: state.target}"
    )
    assert.ok(!stepped.isError, JSON.stringify(stepped))
    assert.deepEqual(JSON.parse(firstText(stepped.content)), {
      lines: ['s0000000a:0 Button "Go"'],
      step: {
        action: "click",
        result: {},
        added: ['s0000000a:2 StaticText "Done"'],
        removed: [],
        unchanged: 1,
      },
      failed: "Wrong screen. The window shows:",
      target: { pid: 42, window_id: 7 },
    })
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
      "const view = await computer.get_window_state({pid: 42, window_id: 7}); state.token = view.elements[0].element_token; const clicked = await computer.click({element_token: state.token}); return {snapshot: view.snapshot_id, click: JSON.parse(clicked.text)}"
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
    assert.equal(executedResult.snapshot, "s0000000a")
    assert.equal(executedResult.click.pid, 42)
    assert.equal(executedResult.click.window_id, 7)
    assert.match(executedResult.click.session, /^mako-paths-[0-9a-f]{8}$/)
    assert.ok(
      Buffer.byteLength(JSON.stringify(executed.content)) < 400,
      "the chain returns its decision, not the tree"
    )
    // An explicit pid wins over the snapshot's; state survives between runs.
    const explicit = await exec(
      client,
      "const clicked = await computer.click({element_token: state.token, pid: 99}); return JSON.parse(clicked.text).pid"
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

    // A background hotkey goes through unchanged; a result the driver could
    // not confirm carries Mako's reading and the routes that can do the job.
    const combo = await exec(
      client,
      "return await computer.hotkey({pid: 42, window_id: 7, keys: ['cmd', 'a']})"
    )
    assert.ok(!combo.isError, JSON.stringify(combo))
    const comboSchema = z
      .object({
        effect: z.literal("unverifiable"),
        delivery: z.object({ mode: z.literal("background") }),
        mako_routes: z.object({
          status: z.enum(["unverifiable", "not-delivered"]),
          reason: z.string(),
          routes: z.string(),
        }),
        content: z.array(z.json()).optional(),
      })
      .loose()
    const comboResult = comboSchema.parse(JSON.parse(firstText(combo.content)))
    assert.equal(comboResult.mako_routes.status, "unverifiable")
    assert.match(comboResult.mako_routes.routes, /invoke_menu/)
    // The program sees the structured data once: no envelope, no text echo.
    assert.equal(comboResult.content, undefined)
    // The driver's delivery_failed escalation becomes an explicit
    // not-delivered verdict rather than a foreground suggestion.
    const dropped = comboSchema.parse(
      JSON.parse(
        firstText(
          (
            await exec(
              client,
              "return await computer.hotkey({pid: 42, window_id: 7, keys: ['cmd', 'x']})"
            )
          ).content
        )
      )
    )
    assert.equal(dropped.mako_routes.status, "not-delivered")
    assert.match(dropped.mako_routes.reason, /Nothing landed/)
    assert.match(dropped.mako_routes.routes, /set_value/)

    // Foreground delivery inside a program still meets Mako's preflight:
    // the fixture's active app is pid 1, so pid 42 is refused before dispatch.
    const foreground = await exec(
      client,
      "return await computer.hotkey({pid: 42, window_id: 7, keys: ['cmd', 'z'], delivery_mode: 'foreground'})"
    )
    assert.equal(foreground.isError, true)
    assert.match(String(foreground.structuredContent?.message), /not frontmost/)
    // The refusal is a thrown error inside the program, so a program can
    // catch it and take a background route instead.
    const recovered = await exec(
      client,
      "try { await computer.hotkey({pid: 42, window_id: 7, keys: ['cmd', 'z'], delivery_mode: 'foreground'}); return 'sent' } catch (error) { return {refused: error.message.includes('frontmost')} }"
    )
    assert.deepEqual(JSON.parse(firstText(recovered.content)), {
      refused: true,
    })

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
console.log(
  "Computer MCP: three-tool program surface with the reference in the tool description, results as data, view/act/expect/windows helpers, menu bar out of window states, window kinds, per-connection task session, symlinked output ancestors resolved, token-only actions carry their snapshot's pid and window, compact window state, hotkey route advice, foreground preflight inside programs, artifact receipts instead of truncation, file captures reach the preview, driver formats compile cleanly"
)
