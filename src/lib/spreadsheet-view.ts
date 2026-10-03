// The 3.1.2 renderer exposes no canvas palette option. This narrow bundler
// adapter keeps its parser, virtualization, formatting and selection behavior;
// only default table chrome reads the desk's tokens. Authored cell styles win.
export * from "../../node_modules/@file-viewer/renderer-spreadsheet/dist/spreadsheet/view.js"
import { createTableConfig as nativeTableConfig, SPREADSHEET_MIN_ZOOM, SPREADSHEET_MAX_ZOOM } from "../../node_modules/@file-viewer/renderer-spreadsheet/dist/spreadsheet/view.js"

export function createTableConfig(input: Parameters<typeof nativeTableConfig>[0]) {
  const config = nativeTableConfig(input)
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => style.getPropertyValue(name).trim()
  // Canvas does not understand CSS variables or oklch strings consistently.
  // Resolve through a tiny DOM color probe once per table configuration.
  const probe = document.createElement("span")
  probe.hidden = true
  document.body.append(probe)
  const color = (name: string) => {
    probe.style.color = token(name)
    return getComputedStyle(probe).color
  }
  const surface = color("--surface")
  const raised = color("--raised")
  const foreground = color("--foreground")
  const muted = color("--muted-foreground")
  const line = color("--hairline")
  const selected = color("--fill-selected")
  probe.remove()
  const scale = Number.isFinite(input.zoomScale ?? 1)
    ? Math.min(SPREADSHEET_MAX_ZOOM, Math.max(SPREADSHEET_MIN_ZOOM, input.zoomScale ?? 1))
    : 1
  const font = `${parseFloat(token("--text-label")) * scale}px ${token("--font-sans")}`
  return {
    ...config,
    HEADER_FONT: `530 ${font}`,
    BODY_FONT: `440 ${font}`,
    BORDER_COLOR: line,
    HEADER_BG_COLOR: raised,
    BODY_BG_COLOR: surface,
    HEADER_TEXT_COLOR: muted,
    BODY_TEXT_COLOR: foreground,
    READONLY_COLOR: surface,
    READONLY_TEXT_COLOR: foreground,
    SCROLLER_COLOR: line,
    SCROLLER_TRACK_COLOR: surface,
    SCROLLER_FOCUS_COLOR: muted,
    EDIT_BG_COLOR: raised,
    SELECT_ROW_COL_BG_COLOR: selected,
    SELECT_AREA_COLOR: selected,
    SELECT_BORDER_COLOR: muted,
    AUTOFILL_POINT_BORDER_COLOR: muted,
    RESIZE_COLUMN_LINE_COLOR: muted,
    RESIZE_ROW_LINE_COLOR: muted,
    HEADER_CELL_STYLE_METHOD: () => ({ backgroundColor: raised, color: muted, font: `530 ${font}` }),
    BODY_CELL_STYLE_METHOD: (args: Parameters<NonNullable<typeof config.BODY_CELL_STYLE_METHOD>>[0]) => {
      const authored = config.BODY_CELL_STYLE_METHOD?.(args)
      return args.colIndex === 0
        ? { ...authored, backgroundColor: raised, color: muted, font: `530 ${font}` }
        : authored
    },
  }
}
