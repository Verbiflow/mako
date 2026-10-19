/**
 * Claude's slash-command envelope is a real prompt; local command output is
 * not. Its `<command-message>` comes before the name in older builds and
 * after it from Claude Code 2.1.283 (`/goal`, `/compact`).
 */
export function claudeCommandPrompt(text: string): string {
  const command = /^\s*(?:<command-message>[\s\S]*?<\/command-message>\s*)?<command-name>(\/[^<\n]+)<\/command-name>\s*(?:<command-message>[\s\S]*?<\/command-message>\s*)?(?:<command-args>([\s\S]*?)<\/command-args>\s*)?$/.exec(text)
  return command ? [command[1], command[2]?.trim()].filter(Boolean).join(" ") : text
}

export function claudeInterrupted(text: string): boolean {
  return /^\[Request interrupted by user(?: for tool use)?\]$/.test(text.trim())
}
