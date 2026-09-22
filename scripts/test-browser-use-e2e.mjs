import assert from "node:assert/strict"
import { z } from "zod"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBrowserToolsServer } from "../dist-electron/browser-tools-main.js"
import { BrowserService } from "../dist-electron/browser-service.js"

const observationSchema = z.object({
  nodes: z.array(
    z.object({
      role: z.string().nullable(),
      name: z.string().nullable(),
      ref: z.string().nullable(),
    })
  ),
})
const root = await mkdtemp(join(tmpdir(), "mako-browser-e2e-"))
const submissions = [],
  events = [],
  clients = [],
  targets = []
const browser = new BrowserService()
const http = createServer(async (req, res) => {
  if (req.method === "POST") {
    let body = ""
    for await (const chunk of req) body += chunk
    submissions.push({ url: req.url, ...JSON.parse(body) })
    res.end("Verified")
    return
  }
  res.setHeader("content-type", "text/html")
  res.end(
    `<title>Mako fixture ${req.url}</title><h1>Mako fixture ${req.url}</h1><label>Proof <input id="proof" aria-label="Proof"></label><button id="verify">Verify proof</button><output></output><script>let trusted=false;document.querySelector('input').oninput=e=>trusted=e.isTrusted;document.querySelector('button').onclick=e=>fetch(location.pathname,{method:'POST',body:JSON.stringify({proof:document.querySelector('input').value,trusted,clicked:e.isTrusted})}).then(r=>r.text()).then(t=>document.querySelector('output').textContent=t)</script>`
  )
})
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve))
const url = `http://127.0.0.1:${http.address().port}`
async function clientFor(owner) {
  const server = createBrowserToolsServer((command, signal) =>
    browser.execute(owner, command, signal)
  )
  const client = new Client({ name: `mako-${owner}`, version: "2" })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  await client.connect(ct)
  clients.push({ client, server })
  return client
}
// Every action is a one-line program; a screenshot is emitted so the image
// arrives as a native block beside its receipt.
async function call(client, action, args = {}, fail = false) {
  const source =
    action === "screenshot"
      ? `emitImage(await browser.screenshot(${JSON.stringify(args)}))`
      : `return await browser.${action}(${JSON.stringify(args)})`
  const result = await client.callTool(
    { name: "mako_browser_exec", arguments: { source } },
    undefined,
    { timeout: 70_000 }
  )
  const text = result.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
  events.push({ action, isError: !!result.isError, text: text.join("\n") })
  assert.equal(!!result.isError, fail, events.at(-1).text)
  return { ...result, value: text[0] === undefined ? null : JSON.parse(text[0]) }
}
let outcome
try {
  const a = await clientFor("a"),
    b = await clientFor("b")
  const candidates = browser.status().filter((item) => item.kind === "chromium")
  const id = process.env.MAKO_TEST_BROWSER ?? (candidates.length === 1 ? candidates[0].id : undefined)
  assert.ok(id, "Choose MAKO_TEST_BROWSER from registered Chromium profiles when more than one is available")
  await call(a, "connect", { browser: id })
  const generation = browser.status().find((item) => item.id === id)
    .connection.generation
  for (const [client, path] of [
    [a, "/a"],
    [b, "/b"],
  ]) {
    const opened = await call(client, "open", { browser: id, url: url + path })
    targets.push(opened.value)
  }
  const [ta, tb] = targets
  assert.match(
    JSON.stringify(
      await call(a, "evaluate", { target: ta, expression: "document.title" })
    ),
    /fixture \/a/
  )
  const screen = await call(a, "screenshot", {
    target: ta,
    format: "png",
    fullPage: true,
  })
  const image = screen.content.find((block) => block.type === "image")
  assert.ok(image)
  const png = Buffer.from(image.data, "base64")
  assert.equal(png.subarray(1, 4).toString(), "PNG")
  assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0)
  const coordinates = screen.value.coordinates
  assert.equal(coordinates.imageWidth, png.readUInt32BE(16))
  assert.equal(coordinates.imageHeight, png.readUInt32BE(20))
  assert.equal(
    coordinates.imageScaleX,
    coordinates.imageWidth / screen.value.clip.width
  )
  assert.equal(
    coordinates.imageScaleY,
    coordinates.imageHeight / screen.value.clip.height
  )
  await writeFile(join(root, "fixture.png"), png)
  const observed = (await call(a, "observe", { target: ta })).value
  const input = observed.nodes.find(
    (node) => node.role === "textbox" && node.name === "Proof"
  )
  const button = observed.nodes.find(
    (node) => node.role === "button" && node.name === "Verify proof"
  )
  assert.ok(input?.ref && button?.ref)
  const proof = randomUUID()
  await call(a, "type", { target: ta, ref: input.ref, text: proof })
  await call(a, "click", { target: ta, at: { ref: button.ref } })
  const deadline = Date.now() + 5000
  while (!submissions.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(submissions, [
    { url: "/a", proof, trusted: true, clicked: true },
  ])
  await a.close()
  const replacement = await clientFor("a")
  const reclaimed = await call(replacement, "select", {
    browser: id,
    tab: ta.tab,
  })
  assert.deepEqual(reclaimed.value, ta)
  assert.equal(
    browser.status().find((item) => item.id === id).connection.generation,
    generation
  )
  await call(replacement, "close", { target: ta })
  await call(
    replacement,
    "type",
    { target: ta, text: "MUST NOT DISPATCH" },
    true
  )
  assert.match(
    JSON.stringify(
      await call(b, "evaluate", { target: tb, expression: "document.title" })
    ),
    /fixture \/b/
  )
  await call(b, "close", { target: tb })
  const appUrl = process.argv
    .find((arg) => arg.startsWith("--app-url="))
    ?.slice("--app-url=".length)
  if (appUrl) {
    const appTarget = (
      await call(replacement, "open", { browser: id, url: appUrl })
    ).value
    try {
      const deadline = Date.now() + 30_000
      let observation
      while (Date.now() < deadline) {
        observation = observationSchema.parse(
          (
            await call(replacement, "observe", {
              target: appTarget,
              maxNodes: 1000,
            })
          ).value
        )
        if (
          observation.nodes.some((node) =>
            node.name?.includes("Audit Mako session handling")
          )
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      await call(replacement, "evaluate", {
        target: appTarget,
        expression:
          "globalThis.makoInputProbe=[]; for (const type of ['pointerdown','pointerup','click']) addEventListener(type,event=>makoInputProbe.push({type,x:event.clientX,y:event.clientY,trusted:event.isTrusted,tag:event.target.tagName,label:event.target.getAttribute('aria-label'),text:event.target.textContent?.slice(0,100)}),true); null",
      })
      const sidebar = observation.nodes.find(
        (node) =>
          node.role === "button" && node.name === "Hide the right sidebar"
      )
      if (sidebar?.ref) {
        await call(replacement, "click", {
          target: appTarget,
          at: { ref: sidebar.ref },
        })
        observation = observationSchema.parse(
          (
            await call(replacement, "observe", {
              target: appTarget,
              maxNodes: 1000,
            })
          ).value
        )
      }
      const thread = observation.nodes.find(
        (node) =>
          node.role === "button" &&
          node.name?.startsWith("Audit Mako session handling")
      )
      assert.ok(
        thread?.ref,
        "Actual audit thread must load from the real host catalog"
      )
      await call(replacement, "click", {
        target: appTarget,
        at: { ref: thread.ref },
      })
      const transcriptDeadline = Date.now() + 15_000
      let exchanges = 0
      while (!exchanges && Date.now() < transcriptDeadline) {
        const measured = await call(replacement, "evaluate", {
          target: appTarget,
          expression:
            "document.querySelectorAll('article[data-exchange]').length",
        })
        exchanges = z
          .number()
          .parse(measured.value.result.value)
        if (!exchanges) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const screenshot = await call(replacement, "screenshot", {
        target: appTarget,
        format: "png",
      })
      const image = screenshot.content.find((block) => block.type === "image")
      assert.ok(image)
      await writeFile(
        join(root, "real-mako.png"),
        Buffer.from(image.data, "base64")
      )
      if (!exchanges) {
        await call(replacement, "evaluate", {
          target: appTarget,
          expression:
            "JSON.stringify({events:globalThis.makoInputProbe,ready:document.readyState,visibility:document.visibilityState})",
        })
        await call(replacement, "observe", {
          target: appTarget,
          maxNodes: 1000,
        })
      }
      assert.ok(exchanges > 0, "Real conversation exchanges must render")
      console.log(
        "PASS: rebuilt Mako browser MCP opens the real web desk and selects the actual audit thread"
      )
    } finally {
      await call(replacement, "close", { target: appTarget })
    }
  }
  outcome = { status: "passed", generation }
  console.log(
    "PASS: shared real Chrome connection, two exact MCP targets, native image and coordinates, trusted input and one click submission, replacement client reuses binding, closed target refused while other task works"
  )
} catch (error) {
  outcome = { status: "failed", error: error.message }
  throw error
} finally {
  for (let i = 0; i < targets.length; i++)
    await browser
      .execute(
        i ? "b" : "a",
        { action: "close", target: targets[i] },
        AbortSignal.timeout(2000)
      )
      .catch(() => {})
  for (const { client, server } of clients) {
    await client.close()
    await server.close()
  }
  browser.close()
  await new Promise((resolve) => http.close(resolve))
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify({ outcome, events, submissions }, null, 2)
  )
  console.log("Evidence:", root)
}
