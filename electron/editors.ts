import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { spawn } from "node:child_process"
import type { ExternalEditor } from "./shared.js"
import { presentMachine } from "./machine.js"
import { onMac } from "./platform.js"

interface EditorDefinition {
  id: string
  label: string
  command: string
  macApps?: string[]
}

const EDITORS: EditorDefinition[] = [
  {
    id: "zed",
    label: "Zed",
    command: "zed",
    macApps: ["Zed", "Zed Preview"],
  },
  { id: "cursor", label: "Cursor", command: "cursor", macApps: ["Cursor"] },
  {
    id: "vscode",
    label: "Visual Studio Code",
    command: "code",
    macApps: ["Visual Studio Code"],
  },
  {
    id: "windsurf",
    label: "Windsurf",
    command: "windsurf",
    macApps: ["Windsurf"],
  },
  {
    id: "sublime",
    label: "Sublime Text",
    command: "subl",
    macApps: ["Sublime Text"],
  },
  { id: "xcode", label: "Xcode", command: "xed", macApps: ["Xcode"] },
]

async function commandExists(command: string): Promise<boolean> {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  const candidates = paths.map((path) => join(path, command))
  const found = await Promise.all(
    candidates.map((path) => access(path).then(() => true).catch(() => false))
  )
  return found.includes(true)
}

async function installedMacApp(names: string[] = []): Promise<string | undefined> {
  if (!onMac()) return undefined
  for (const name of names) {
    const paths = [
      join("/Applications", `${name}.app`),
      join(homedir(), "Applications", `${name}.app`),
    ]
    const found = await Promise.all(
      paths.map((path) => access(path).then(() => true).catch(() => false))
    )
    if (found.includes(true)) return name
  }
  return undefined
}

export async function listExternalEditors(): Promise<ExternalEditor[]> {
  const detected = await Promise.all(
    EDITORS.map(async (editor) => ({
      id: editor.id,
      label: editor.label,
      available:
        (await commandExists(editor.command)) ||
        Boolean(await installedMacApp(editor.macApps)),
    }))
  )
  return detected.filter((editor) => editor.available)
}

export async function openInExternalEditor(
  path: string,
  editorId?: string
): Promise<void> {
  const available = await listExternalEditors()
  const selected =
    EDITORS.find(
      (editor) =>
        editor.id === editorId &&
        available.some((candidate) => candidate.id === editor.id)
    ) ??
    EDITORS.find((editor) =>
      available.some((candidate) => candidate.id === editor.id)
    )
  if (!selected) {
    await presentMachine().reveal(path)
    return
  }

  const hasCommand = await commandExists(selected.command)
  const macApp = await installedMacApp(selected.macApps)
  const command = hasCommand ? selected.command : "open"
  const args = hasCommand ? [path] : ["-a", macApp ?? selected.label, path]
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  })
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
  child.unref()
}
