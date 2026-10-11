import { createMarkdownCommands } from "../file-authoring.js"

export function createOpenCodeCommands() {
  return createMarkdownCommands("opencode", ".opencode/commands")
}
