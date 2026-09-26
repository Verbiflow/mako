import assert from "node:assert/strict"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { createBrowserToolsServer } from "../electron/browser-tools-main.js"
import { BrowserService } from "../packages/control-runtime/src/browser-service.js"
import { browserFixture } from "./browser-control-fixture.js"

const artifactsRoot = join(tmpdir(), `mako-browser-artifacts-${process.pid}`)
process.env.MAKO_CONTROL_ARTIFACTS = artifactsRoot
const fixture = await browserFixture()
const service = new BrowserService([fixture.definition])
const server = createBrowserToolsServer(
  (command, signal) => service.execute("mcp-fixture", command, signal),
  "browser-test"
)
const client = new Client({ name: "browser-regression", version: "3" })
const textBlocks = z.array(
  z.object({ type: z.string(), text: z.string().optional() })
)
const firstText = (content: CallToolResult["content"] | undefined) =>
  z.string().parse(textBlocks.parse(content)[0]?.text)
try {
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  await client.connect(ct)
  const instructions = client.getInstructions() ?? ""
  assert.match(instructions, /no implicit active tab/)
  // The API reference in the instructions is generated from the contract,
  // so a program can be written from the instructions alone.
  assert.match(instructions, /browser\.click\(\{target, at, button\?, /)
  assert.match(instructions, /browser\.observe\(\{within\?, match\?, target, /)
  assert.match(instructions, /never cut/i)
  const tools = (await client.listTools()).tools
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["mako_browser_exec", "mako_browser_help", "mako_browser_status"],
    "the surface is three tools; every action is a program call"
  )
  const catalogBytes = Buffer.byteLength(JSON.stringify(tools))
  assert.ok(catalogBytes < 4_000, `tool catalog is ${catalogBytes} bytes`)
  for (const tool of tools) {
    const schema = z
      .object({
        inputSchema: z.object({
          properties: z.record(
            z.string(),
            z.object({ description: z.string() }).loose()
          ),
        }),
      })
      .parse(tool)
    for (const property of Object.keys(schema.inputSchema.properties))
      assert.ok(
        schema.inputSchema.properties[property]?.description,
        `${tool.name}.${property} has a description`
      )
  }

  // Help: every action's signature, one action's full schema, and the
  // protocol reference for cdp.
  const index = z
    .object({
      actions: z.array(
        z.object({
          action: z.string(),
          signature: z.string(),
          summary: z.string(),
        })
      ),
    })
    .parse(
      JSON.parse(
        firstText(
          (await client.callTool({ name: "mako_browser_help", arguments: {} }))
            .content
        )
      )
    )
  assert.ok(index.actions.some((entry) => entry.action === "upload"))
  const open = z
    .object({
      action: z.literal("open"),
      signature: z.string(),
      description: z.string(),
      inputSchema: z.object({
        required: z.array(z.string()),
        properties: z.record(
          z.string(),
          z.object({ description: z.string().optional() }).loose()
        ),
      }),
    })
    .parse(
      JSON.parse(
        firstText(
          (
            await client.callTool({
              name: "mako_browser_help",
              arguments: { action: "open" },
            })
          ).content
        )
      )
    )
  assert.deepEqual(open.inputSchema.required, ["browser"])
  assert.match(open.signature, /^browser\.open\(\{browser, url\?/)
  for (const [property, definition] of Object.entries(
    open.inputSchema.properties
  ))
    assert.ok(definition.description, `open.${property} is described`)
  const cdpHelp = z
    .object({
      action: z.literal("cdp"),
      inputSchema: z.object({
        required: z.array(z.string()),
        $defs: z.record(z.string(), z.json()).optional(),
      }),
    })
    .parse(
      JSON.parse(
        firstText(
          (
            await client.callTool({
              name: "mako_browser_help",
              arguments: { action: "cdp" },
            })
          ).content
        )
      )
    )
  assert.deepEqual(cdpHelp.inputSchema.required, ["target", "method"])
  const cdpText = JSON.stringify(cdpHelp.inputSchema)
  for (const reference of cdpText.matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g))
    assert.ok(
      cdpHelp.inputSchema.$defs?.[reference[1]],
      `cdp $ref ${reference[1]} resolves`
    )
  const unknownAction = await client.callTool({
    name: "mako_browser_help",
    arguments: { action: "teleport" },
  })
  assert.equal(unknownAction.isError, true)
  assert.match(String(unknownAction.structuredContent?.message), /Actions:/)
  const protocolHelp = await client.callTool({
    name: "mako_browser_help",
    arguments: { domain: "Input", method: "insertText" },
  })
  assert.ok(!protocolHelp.isError)
  assert.match(JSON.stringify(protocolHelp), /insertText/)

  // A removed per-action tool is refused by name with the way in.
  const legacy = await client.callTool({
    name: "mako_browser_click",
    arguments: {},
  })
  assert.equal(legacy.isError, true)
  assert.match(String(legacy.structuredContent?.message), /mako_browser_exec/)

  // Status is a direct read.
  const status = await client.callTool({
    name: "mako_browser_status",
    arguments: {},
  })
  assert.ok(!status.isError)
  assert.equal(fixture.connections(), 0)

  // Invalid arguments inside a program dispatch nothing and name the action
  // and the field.
  const invalid = await client.callTool({
    name: "mako_browser_exec",
    arguments: {
      source:
        "return await browser.click({target:{browser:'fixture',tab:'tab',generation:'g',lease:'l'}, at:'{\"ref\":\"not-an-object\"}'})",
    },
  })
  assert.equal(invalid.isError, true)
  assert.match(String(invalid.structuredContent?.message), /browser\.click/)
  assert.match(String(invalid.structuredContent?.message), /at/)
  assert.match(
    String(invalid.structuredContent?.message),
    /Nothing was dispatched/
  )
  assert.equal(fixture.calls.length, 0)

  // A whole workflow in one call: connect, open, observe, screenshot.
  const result = await client.callTool({
    name: "mako_browser_exec",
    arguments: {
      source:
        "await browser.connect({browser:'fixture'}); state.tab = await browser.open({browser:'fixture'}); console.log(await browser.observe({target:state.tab})); emitImage(await browser.screenshot({target:state.tab,format:'png'}));",
    },
  })
  assert.ok(!result.isError, JSON.stringify(result))
  assert.ok(result.content.some((block) => block.type === "image"))
  assert.ok(
    result.content.some(
      (block) =>
        block.type === "text" &&
        block.text.includes('"target"') &&
        block.text.includes('"view"')
    )
  )
  const persisted = await client.callTool({
    name: "mako_browser_exec",
    arguments: {
      source:
        "return await browser.evaluate({target:state.tab,expression:'document.title'})",
    },
  })
  assert.ok(!persisted.isError, JSON.stringify(persisted))

  // A later failure keeps what earlier statements emitted, before the fault.
  const failedLate = await client.callTool({
    name: "mako_browser_exec",
    arguments: {
      source:
        "console.log('before'); emitImage(await browser.screenshot({target:state.tab,format:'png'})); await browser.click({target:state.tab, at:'{\"ref\":\"not-an-object\"}'})",
    },
  })
  assert.equal(failedLate.isError, true)
  const lateBlocks = z.array(z.object({ type: z.string(), text: z.string().optional() })).parse(failedLate.content)
  assert.deepEqual(lateBlocks[0], { type: "text", text: '"before"' })
  assert.ok(lateBlocks.some((block) => block.type === "image"), "Earlier images survive a later failure")
  assert.match(String(lateBlocks.at(-1)!.text), /browser\.click/)
  assert.match(String(failedLate.structuredContent?.message), /browser\.click/)
  assert.equal(failedLate.structuredContent?.outcome, "not-dispatched")

  // Oversized output is written whole to a file and described, never cut.
  const oversized = await client.callTool({
    name: "mako_browser_exec",
    arguments: {
      source:
        "return await browser.evaluate({target:state.tab,expression:'big-result'})",
    },
  })
  assert.ok(!oversized.isError, JSON.stringify(oversized).slice(0, 300))
  const receipt = z
    .object({
      artifact: z.literal(true),
      kind: z.literal("json"),
      path: z.string(),
      bytes: z.number(),
      sha256: z.string().length(64),
      outline: z.object({
        type: z.literal("object"),
        keys: z.array(
          z.object({ name: z.string(), type: z.string(), bytes: z.number() })
        ),
      }),
      note: z.string(),
    })
    .parse(JSON.parse(firstText(oversized.content)))
  assert.ok(receipt.bytes > 300_000)
  assert.ok(receipt.path.startsWith(join(artifactsRoot, "browser")))
  assert.ok(Buffer.byteLength(JSON.stringify(oversized.content)) < 4_000)
  const saved = z
    .object({ result: z.object({ value: z.string() }) })
    .parse(JSON.parse(await readFile(receipt.path, "utf8")))
  assert.equal(saved.result.value.length, 300_000, "nothing was cut")
  assert.ok(
    receipt.outline.keys.some(
      (key) => key.name === "result" && key.type === "object"
    )
  )
  // A program can keep the big value out of its result and save it itself.
  const chosen = await client.callTool({
    name: "mako_browser_exec",
    arguments: {
      source:
        "const big = await browser.evaluate({target:state.tab,expression:'big-result'}); const file = artifacts.save('title-dump', big); return {length: big.result.value.length, file}",
    },
  })
  assert.ok(!chosen.isError, JSON.stringify(chosen))
  const summary = z
    .object({
      length: z.literal(300_000),
      file: z.object({ path: z.string(), bytes: z.number() }),
    })
    .parse(JSON.parse(firstText(chosen.content)))
  assert.match(summary.file.path, /title-dump-[0-9a-f]{8}\.json$/)

  await client.close()
  await server.close()
  assert.equal(service.status()[0].connection.status, "connected")
  assert.equal(fixture.connections(), 1)
  console.log(
    "Browser MCP: three-tool program surface with a generated API reference, per-action and protocol help, actionable validation faults, artifact receipts instead of truncation, persistent scripts, native images with identity, and connection survival after MCP close"
  )
} finally {
  await client.close()
  await server.close()
  service.close()
  await fixture.close()
  await rm(artifactsRoot, { recursive: true, force: true })
}
