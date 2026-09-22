import type { ITheme } from "@xterm/xterm"

export function terminalTheme(style: CSSStyleDeclaration): ITheme {
  return {
    background: style.getPropertyValue("--surface"),
    foreground: style.getPropertyValue("--foreground"),
    cursor: style.getPropertyValue("--foreground"),
    cursorAccent: style.getPropertyValue("--surface"),
    selectionBackground: style.getPropertyValue("--fill-selected"),
    black: style.getPropertyValue("--background"),
    brightBlack: style.getPropertyValue("--faint"),
    white: style.getPropertyValue("--muted-foreground"),
    brightWhite: style.getPropertyValue("--foreground"),
    red: style.getPropertyValue("--negative"),
    brightRed: style.getPropertyValue("--removed"),
    green: style.getPropertyValue("--positive"),
    brightGreen: style.getPropertyValue("--added"),
    yellow: style.getPropertyValue("--caution"),
    brightYellow: style.getPropertyValue("--caution"),
    blue: style.getPropertyValue("--terminal-blue"),
    brightBlue: style.getPropertyValue("--terminal-bright-blue"),
    cyan: style.getPropertyValue("--terminal-cyan"),
    brightCyan: style.getPropertyValue("--terminal-bright-cyan"),
    magenta: style.getPropertyValue("--terminal-magenta"),
    brightMagenta: style.getPropertyValue("--terminal-bright-magenta"),
  }
}
