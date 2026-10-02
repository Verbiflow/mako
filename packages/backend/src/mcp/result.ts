import { stringify } from "yaml"

const MAX_TEXT_BYTES = 1024 * 1024

export function textResult(text: string) {
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new Error("MCP text result exceeded the 1 MB response limit")
  }
  return {
    content: [{ type: "text" as const, text }],
  }
}

/**
 * Structured results as YAML: it parses back to the same values without
 * JSON's quotes, braces and escapes, so a model reads less for the same facts.
 */
export function yamlResult<Report>(report: Report) {
  return textResult(
    stringify(report, {
      lineWidth: 0,
      minContentWidth: 0,
      aliasDuplicateObjects: false,
    }).trimEnd()
  )
}
