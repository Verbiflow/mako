import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { setTimeout as pause } from "node:timers/promises"
import { homedir } from "node:os"
import { createOpenCodeCommands } from "@mako/host/harnesses/opencode/authoring"
import { readSources } from "@mako/host/tools/native-authoring"
import { AuthoringFiles, revisionOf } from "@mako/host/tools/authoring-files"

const openCodeCommands = createOpenCodeCommands()

/** Writes the project command `name` through OpenCode's own authoring declaration, as Settings does. */
async function writeCommand(root: string, name: string, text: string): Promise<void> {
  const sources = await readSources(openCodeCommands, { cwd: root, home: homedir(), env: process.env })
  const folder = sources.find((source) => source.spec.scope === "project" && source.spec.format === "folder")!
  const existing = folder.files.some((file) => file.path === `${name}.md`)
  const edit = openCodeCommands.change(sources, existing
    ? { kind: "edit", entryId: `${folder.spec.id}#${name}.md`, draft: { kind: "command", invocation: name, text } }
    : { kind: "create", sourceId: folder.spec.id, draft: { kind: "command", invocation: name, text } })
  await new AuthoringFiles(join(root, ".mako-backups")).write(edit.root, edit.path, revisionOf(edit.before), edit.after, null)
}

const data = process.env.MAKO_THREAD_DATA_DIR
if (!data) throw new Error("Run this installed probe within an allocated Thread")
const root = join(data, "native-authoring")
if (process.argv.includes("--prepare")) {
  await mkdir(root, { recursive: true })
  await writeCommand(root, "mako-native-proof", "---\ndescription: Mako native command discovery proof\n---\nInspect $ARGUMENTS and report the evidence.\n")
  console.log("Prepared an authored project command in the private Thread workspace")
} else {
  const url = process.env.MAKO_AUTHORING_API
  if (!url) throw new Error("Set MAKO_AUTHORING_API to the app-managed native server")
  const client = OpenCode.make({ baseUrl: url, headers: { Authorization: `Basic ${Buffer.from("opencode:mako-disposable-authoring-proof").toString("base64")}` } })
  const location = { directory: root }, options = { signal: AbortSignal.timeout(20_000) }
  // OpenCode lists commands before its plugins finish activating, so the list can be read early.
  const listed = async () => (await client.command.list({ location }, options)).data.find(item => item.name === "mako-native-proof")
  let command = await listed()
  for (let attempt = 0; attempt < 100 && !command; attempt++) {
    await pause(50)
    command = await listed()
  }
  assert.ok(command, "The installed OpenCode server must discover the saved project command")
  assert.equal(command.description, "Mako native command discovery proof")
  await writeCommand(root, "mako-native-proof", "---\ndescription: Mako native reload proof\n---\nInspect only the staged diff.\n")
  let reloaded = command
  for (let attempt = 0; attempt < 100 && reloaded.description !== "Mako native reload proof"; attempt++) {
    await pause(50)
    reloaded = (await client.command.list({ location }, options)).data.find(item => item.name === command.name) ?? reloaded
  }
  assert.equal(reloaded.description, "Mako native reload proof", "Native file watching must reload the authored edit without a server restart")
  await writeFile(join(data, "native-authoring-opencode.json"), JSON.stringify({ native: await client.server.info(), command, reloaded, modelPromptSent: false }, null, 2) + "\n")
  console.log("Installed OpenCode discovered and reloaded the authored native command; no model request was sent")
}
