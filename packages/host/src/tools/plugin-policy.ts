export const MAX_UI_EXTENSIONS = 64
export const MAX_UI_EXTENSION_BYTES = 512 * 1024

export function uiExtensionName(id: string): string {
  return id.replace(/[^\w.-]/g, "-").replace(/^[^A-Za-z0-9_]+/, "")
}

export function validateUiExtensionWrite(
  id: string,
  source: string,
  existingIds: string[]
): string {
  const name = uiExtensionName(id)
  if (!name) throw new Error("A local UI extension needs a name")
  if (Buffer.byteLength(source) > MAX_UI_EXTENSION_BYTES) {
    throw new Error(
      `A local UI extension cannot exceed ${MAX_UI_EXTENSION_BYTES / 1024} KB`
    )
  }
  if (!existingIds.includes(name) && existingIds.length >= MAX_UI_EXTENSIONS) {
    throw new Error(`Mako loads at most ${MAX_UI_EXTENSIONS} local UI extensions`)
  }
  return name
}
