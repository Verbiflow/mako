/**
 * An item body made of named fields, for the agent to read and for Mako to
 * read back:
 *
 *   comment: Make this bigger
 *   code:
 *     const total = items.length
 *     return total
 *
 * A one-line value follows its name. A value with line breaks starts on
 * the next line, each line indented two spaces, an empty line kept as two
 * spaces so it stays inside its field. Field names are fixed by each kind,
 * so the reader needs no escaping: a line starting with `name:` at the
 * margin begins the next field, and nothing a value holds starts at the
 * margin.
 */

export type Fields = ReadonlyArray<readonly [name: string, value: string | undefined]>

export function writeFields(fields: Fields): string {
  return fields
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined && entry[1] !== "")
    .map(([name, value]) =>
      value.includes("\n") || value !== value.trim()
        ? `${name}:\n${value.split("\n").map((line) => `  ${line}`).join("\n")}`
        : `${name}: ${value}`
    )
    .join("\n")
}

/** The fields of a body, by name; a line that belongs to none is ignored. */
export function readFields(body: string, names: readonly string[]): Map<string, string> {
  const fields = new Map<string, string>()
  let current: { name: string; lines: string[] } | null = null
  const close = () => {
    if (current) fields.set(current.name, current.lines.join("\n"))
    current = null
  }
  for (const line of body.split("\n")) {
    const head = /^([a-z][\w-]*):(?: (.*))?$/.exec(line)
    if (head && names.includes(head[1]!)) {
      close()
      if (head[2] !== undefined) fields.set(head[1]!, head[2])
      else current = { name: head[1]!, lines: [] }
      continue
    }
    if (current && line.startsWith("  ")) current.lines.push(line.slice(2))
  }
  close()
  return fields
}
