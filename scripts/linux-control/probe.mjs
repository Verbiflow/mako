import { execFile } from "node:child_process"
import { promisify } from "node:util"
import assert from "node:assert/strict"
import { access, readFile, writeFile } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
const run = promisify(execFile)
const driver = process.env.MAKO_TEST_DRIVER ?? "/target/debug/cua-driver"
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const read = async (path) => JSON.parse(await readFile(path, "utf8"))
for (let i = 0; i < 200; i++) {
  try {
    await read("/tmp/target.json")
    await read("/tmp/user.json")
    break
  } catch {
    await pause(50)
  }
}
for (let i = 0; i < 200; i++) {
  try {
    await access("/tmp/mako-driver.sock")
    break
  } catch {
    await pause(50)
  }
}
const target = await read("/tmp/target.json")
const user = await read("/tmp/user.json")
const client = new Client({ name: "mako-linux-acceptance", version: "1" })
const transport = new StdioClientTransport({
  command: driver,
  args: ["mcp", "--socket", "/tmp/mako-driver.sock"],
  env: { ...process.env },
  stderr: "pipe",
})
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk))
const evidence = { targetPid: target.pid, userPid: user.pid, checks: [] }
try {
  await client.connect(transport)
  const call = async (name, args = {}) => {
    const started = performance.now()
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 60000,
    })
    if (result.isError) throw new Error(JSON.stringify(result))
    if (name === "get_window_state")
      assert.equal(
        result.content.some((block) => block.type === "image"),
        false,
        "Text reads must not include screenshots"
      )
    evidence.checks.push({ name, ms: performance.now() - started })
    return result.structuredContent ?? result
  }
  const tools = await client.listTools()
  await writeFile(
    "/evidence/tools.json",
    JSON.stringify(
      {
        tools: tools.tools.filter((t) =>
          [
            "get_window_state",
            "list_windows",
            "set_value",
            "click",
            "type_text",
          ].includes(t.name)
        ),
      },
      null,
      2
    )
  )
  const windows = await call("list_windows", { pid: target.pid })
  evidence.windows = windows
  assert.equal(windows.platform, "linux")
  assert.equal(windows.backend, "x11")
  const window = windows.windows.find((w) => w.title === "Mako target")
  assert.ok(window)
  const address = { pid: target.pid, window_id: window.window_id }
  const view = await call("get_window_state", {
    ...address,
    include_screenshot: false,
    max_elements: 300,
  })
  evidence.initial = view
  await writeFile("/evidence/initial.json", JSON.stringify(view, null, 2))
  assert.equal(view.elements_complete, true)
  const entry = view.elements.find((e) => e.label === "Exact text")
  assert.ok(entry)
  assert.equal(entry.value, "")
  assert.equal(entry.value_exact, true)
  // Exercise the public Mako host and strict locators, not just raw driver calls.
  const host = new Client({ name: "mako-linux-public-api", version: "1" })
  await host.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "/repo/packages/control-runtime/dist/computer-tools-main.js",
        "--driver",
        driver,
        "--socket",
        "/tmp/mako-driver.sock",
      ],
      env: { ...process.env },
      stderr: "inherit",
    })
  )
  const cell = async (source) => {
    let result = await host.callTool(
      { name: "mako_control_exec", arguments: { source } },
      undefined,
      { timeout: 60000 }
    )
    for (;;) {
      const first = result.content.find((b) => b.type === "text")
      let receipt
      try {
        receipt = JSON.parse(first?.text ?? "{}")
      } catch {}
      if (receipt?.status !== "running" || !Number.isInteger(receipt.cell))
        break
      result = await host.callTool(
        { name: "mako_control_exec", arguments: { cell: receipt.cell } },
        undefined,
        { timeout: 60000 }
      )
    }
    if (result.isError) throw new Error(JSON.stringify(result))
    const blocks = result.content.filter((b) => b.type === "text")
    return JSON.parse(blocks.at(-1).text)
  }
  try {
    await cell(
      `state.window=control.window(${JSON.stringify(address)});return true;`
    )
    const userWindows = await call("list_windows", { pid: user.pid })
    const userWindow = userWindows.windows.find(
      (w) => w.title === "User typing"
    )
    await run("xdotool", [
      "windowactivate",
      "--sync",
      String(userWindow.window_id),
    ])
    const foreground = await cell(
      `try {await control.native('type_text',{...${JSON.stringify(address)},text:'must-not-type',delivery_mode:'foreground',foreground:true});return {refused:false}}catch(error){return {refused:true,message:error.message,outcome:error.outcome}}`
    )
    assert.equal(foreground.refused, true)
    assert.equal(foreground.outcome, "not-dispatched")
    assert.match(foreground.message, /could not verify keyboard focus/)
    const rawForeground = await client.callTool({
      name: "type_text",
      arguments: {
        ...address,
        text: "must-not-type",
        delivery_mode: "foreground",
      },
    })
    assert.equal(
      rawForeground.isError,
      true,
      "The driver must also refuse without activating the target"
    )
    await pause(50)
    assert.equal((await read("/tmp/target.json")).entry, "")
    assert.equal((await read("/tmp/user.json")).entry, "")
    evidence.foregroundRefusedByHostAndDriver = true
    const userTyping = Array.from(
      { length: 80 },
      (_, index) => `[${index.toString(36).padStart(3, "0")}]`
    ).join("")
    const typing = run("xdotool", [
      "type",
      "--clearmodifiers",
      "--delay",
      "12",
      userTyping,
    ])
    evidence.jobs = []
    const valueCases = [
      "",
      "  ",
      "  東京 🐟  ",
      "00123",
      "\tline\n",
      "long-" + "x".repeat(6000) + "-end",
    ]
    const values = Array.from({ length: 5 }, () => valueCases).flat()
    const typedAtStart = (await read("/tmp/user.json")).entry.length
    for (const value of values) {
      const started = performance.now()
      const proof = await cell(
        `await state.window.locator({role:'TextArea',name:'Long text'}).setValue(${JSON.stringify(value)}); const proof=await state.window.locator({role:'TextArea',name:'Long text'}).expect({value:${JSON.stringify(value)}}); await state.window.locator({role:'Button',name:'Save'}).click(); return {status:proof.status};`
      )
      assert.equal(proof.status, "matched")
      await pause(40)
      const actual = await read("/tmp/target.json")
      assert.equal(actual.text, value)
      assert.equal(actual.saves, evidence.jobs.length + 1)
      assert.equal(actual.active, false)
      evidence.jobs.push({
        characters: [...value].length,
        ms: performance.now() - started,
        saves: actual.saves,
      })
    }
    const typedAtEnd = (await read("/tmp/user.json")).entry.length
    await typing
    await pause(50)
    assert.equal((await read("/tmp/user.json")).entry, userTyping)
    evidence.concurrentTyping = {
      expected: userTyping.length,
      duringJobs: typedAtEnd - typedAtStart,
      actual: (await read("/tmp/user.json")).entry.length,
    }
    const limited = await call("get_window_state", {
      ...address,
      include_screenshot: false,
      max_elements: 2,
    })
    assert.equal(limited.elements_complete, false)
    evidence.boundedWalkRefusesCompleteness = true
    const current = await call("list_windows", { pid: user.pid })
    assert.equal(
      current.windows.find((w) => w.window_id === userWindow.window_id).focused,
      true
    )
    await cell(
      `const view=await state.window.observe();state.originalField=view.get({role:'TextArea',name:'Long text'}).ref;state.originalSave=view.get({role:'Button',name:'Save'}).ref;return true;`
    )
    await writeFile(
      "/tmp/fixture-command.json",
      JSON.stringify({ reorder: true })
    )
    await pause(100)
    await cell(
      `await state.window.setValue(state.originalField,'after reorder');return true;`
    )
    await pause(60)
    assert.equal((await read("/tmp/target.json")).text, "after reorder")
    assert.equal((await read("/tmp/target.json")).decoy, "untouched")
    await cell(
      `const view=await state.window.observe();state.originalSave=view.get({role:'Button',name:'Save'}).ref;return true;`
    )
    await writeFile(
      "/tmp/fixture-command.json",
      JSON.stringify({ reorder: true, reorderAgain: true })
    )
    await pause(100)
    await cell(`await state.window.click(state.originalSave);return true;`)
    await pause(60)
    assert.equal((await read("/tmp/target.json")).saves, values.length + 1)
    await cell(
      `const view=await state.window.observe();state.originalField=view.get({role:'TextArea',name:'Long text'}).ref;return true;`
    )
    await writeFile(
      "/tmp/fixture-command.json",
      JSON.stringify({ reorder: true, replace: true })
    )
    await pause(100)
    const stale = await cell(
      `try {await state.window.setValue(state.originalField,'wrong replacement');return false}catch{return true}`
    )
    assert.equal(stale, true)
    assert.equal((await read("/tmp/target.json")).text, "replacement untouched")
    evidence.retainedIdentity = {
      reorderPassed: true,
      replacementRefused: true,
      decoyUnchanged: true,
    }
    await cell(
      `const view=await state.window.observe();state.blockedField=view.get({role:'TextArea',name:'Long text'}).ref;return true;`
    )
    await writeFile(
      "/tmp/fixture-command.json",
      JSON.stringify({ reorder: true, replace: true, modal: true })
    )
    await pause(150)
    assert.equal((await read("/tmp/target.json")).modal, true)
    const blocked = await cell(
      `try {await state.window.setValue(state.blockedField,'must not bypass modal');return false}catch{return true}`
    )
    assert.equal(blocked, true)
    assert.equal((await read("/tmp/target.json")).text, "replacement untouched")
    await writeFile(
      "/tmp/fixture-command.json",
      JSON.stringify({ reorder: true, replace: true })
    )
    await pause(100)
    evidence.modalParentRefused = true
    const fresh = await call("get_window_state", {
      ...address,
      include_screenshot: false,
      max_elements: 300,
    })
    const longField = fresh.elements.find((e) => e.label === "Long text")
    await call("set_value", {
      ...address,
      element_token: longField.element_token,
      value: "x".repeat(100001),
    })
    const capped = await call("get_window_state", {
      ...address,
      include_screenshot: false,
      max_elements: 300,
    })
    const cappedField = capped.elements.find((e) => e.label === "Long text")
    assert.equal(cappedField.value_exact, false)
    assert.equal(cappedField.text_truncated, true)
    assert.equal(capped.truncated, true)
    evidence.longValueCap = {
      actual: 100001,
      returned: cappedField.value.length,
      exact: false,
    }
    evidence.status = "passed"
  } finally {
    await host.close()
  }
} finally {
  await writeFile("/evidence/results.json", JSON.stringify(evidence, null, 2))
  await client.close()
}
