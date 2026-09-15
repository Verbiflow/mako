import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { imageFixture } from "./provider-e2e-fixtures.mjs"

export async function runBrowserFixture(
  owner,
  root,
  providers,
  browserOperations,
  models
) {
  const proof = randomUUID()
  const submissions = []
  const image = imageFixture().toString("base64")
  const html = `<title>Mako model browser fixture</title><h1>Mako model browser fixture</h1><p>Fixture value: <strong>${proof}</strong></p><img src="data:image/png;base64,${image}" alt="Count the colored squares"><form><label>Fixture value <input name="proof" aria-label="Fixture value"></label><label>Red squares <input name="red" aria-label="Red squares"></label><label>Blue squares <input name="blue" aria-label="Blue squares"></label><button type="submit">Verify</button></form><output></output><script>
 const trusted = new Set(); let clicked = false;
 document.querySelector('form').addEventListener('input',event=>{if(event.isTrusted)trusted.add(event.target.name)});
 document.querySelector('button').addEventListener('click',event=>{clicked=event.isTrusted});
 document.querySelector('form').addEventListener('submit',event=>{event.preventDefault(); const form=new FormData(event.target);fetch(location.pathname,{method:'POST',body:JSON.stringify({proof:form.get('proof'),red:form.get('red'),blue:form.get('blue'),trusted:[...trusted].sort(),clicked})}).then(async response=>document.querySelector('output').textContent=await response.text())});
 </script>`
  const server = createServer(async (req, res) => {
    if (req.method === "POST") {
      let body = ""
      for await (const chunk of req) {
        body += chunk
        if (body.length > 4096) {
          res.writeHead(413)
          res.end()
          return
        }
      }
      const value = JSON.parse(body)
      submissions.push({ path: req.url, ...value })
      const valid =
        value.proof === proof &&
        value.red === "4" &&
        value.blue === "2" &&
        value.clicked === true &&
        JSON.stringify(value.trusted) ===
          JSON.stringify(["blue", "proof", "red"])
      res.end(valid ? "Verified successfully" : "Verification failed")
      return
    }
    res.setHeader("content-type", "text/html")
    res.end(html)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const results = []
  try {
    for (const provider of providers) {
      const id = randomUUID(),
        requestId = randomUUID(),
        cwd = join(root, `browser-${provider}`)
      await mkdir(cwd)
      const result = { flow: "model-browser-mcp", provider, status: "pending" }
      results.push(result)
      const wait = async (predicate) => {
        const deadline = Date.now() + 240_000
        while (Date.now() < deadline) {
          const snapshot = owner.snapshot(id)
          for (const permission of snapshot?.permissions ?? []) {
            const once = permission.options.find(
              (option) => option.kind === "allow_once"
            )
            const permitted = [
              "mako_browser_status",
              "mako_browser_help",
              "mako_browser_exec",
            ].some(
              (tool) =>
                permission.title ===
                  `mako-browser-use: Allow the mako-browser-use MCP server to run tool "${tool}"?` ||
                permission.title === `mcp__mako-browser-use__${tool}` ||
                permission.title === `mako-browser-use: ${tool}` ||
                permission.title === `mako-browser-use-${tool}: ${tool}`
            )
            if (!once || !permitted)
              throw new Error(
                `Permission outside browser fixture grant: ${permission.title}`
              )
            await owner.permission(id, permission.id, {
              kind: "choice",
              optionId: once.optionId,
            })
          }
          if (predicate(snapshot)) return snapshot
          if (snapshot?.session.status === "failed")
            throw new Error(snapshot.session.error ?? "Provider failed")
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        throw new Error("Model browser fixture timed out")
      }
      try {
        await owner.start(provider, cwd, {
          conversationId: id,
          title: "Mako model browser fixture",
          tuning: models[provider] ? { model: models[provider] } : undefined,
        })
        await wait((snapshot) => snapshot?.session.status === "ready")
        owner.submit(
          id,
          requestId,
          `This is an authorized disposable browser integration test. Use the mako-browser-use MCP tools (mako_browser_exec programs) to open ${url}/${provider}. Emit a screenshot with emitImage(await browser.screenshot({target})) to inspect the picture. Read the displayed fixture value and count the red and blue squares. Fill all three form fields and click Verify, then confirm the page says Verified successfully. Use real browser input and click events through the browser tools, not direct network requests, DOM value assignments, or synthetic DOM events. Do not use shell, files, other browser tools, or other websites. Close only your created fixture tab after verification. Reply with the fixture value and the counts.`
        )
        const completed = await wait((snapshot) =>
          snapshot?.requests.some(
            (request) =>
              request.id === requestId && request.status === "completed"
          )
        )
        const calls = completed.blocks.filter((block) => block.type === "tool")
        const reply = completed.blocks
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
        const records = submissions.filter(
          (item) => item.path === `/${provider}`
        )
        if (
          records.length !== 1 ||
          records[0].proof !== proof ||
          records[0].red !== "4" ||
          records[0].blue !== "2" ||
          !records[0].clicked ||
          JSON.stringify(records[0].trusted) !==
            JSON.stringify(["blue", "proof", "red"])
        )
          throw new Error(
            `Real browser form was not submitted exactly once with trusted input and correct values: ${JSON.stringify(records)}`
          )
        const operations = browserOperations
          .filter((operation) => operation.conversationId === id)
          .map((operation) => operation.action)
        if (!operations.includes("screenshot"))
          throw new Error(
            "No browser screenshot completed for this conversation"
          )
        result.operations = operations
        if (!reply.includes(proof))
          throw new Error(
            "Model response did not include the observed fixture value"
          )
        result.status = "passed"
        result.nativeId = completed.session.nativeId
        result.toolCalls = calls.map((block) => block.title)
        result.submission = records[0]
      } catch (error) {
        result.status = "failed"
        result.error = error.message
      } finally {
        const snapshot = owner.snapshot(id)
        if (snapshot)
          await writeFile(
            join(root, `browser-${provider}.json`),
            JSON.stringify(snapshot, null, 2)
          )
        if (snapshot) owner.close(id)
      }
      console.log(JSON.stringify(result))
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await writeFile(
      join(root, "browser-results.json"),
      JSON.stringify({ proof, submissions, results }, null, 2)
    )
  }
  return results
}
