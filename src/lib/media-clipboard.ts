/**
 * The picture at `url` on the clipboard as a PNG, the one image type every
 * clipboard reader takes; any other type is redrawn as one first.
 */
export async function copyImage(url: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`The image didn't load (${response.status})`)
  const blob = await response.blob()
  const png = blob.type === "image/png" ? blob : await redrawAsPng(blob)
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
}

async function redrawAsPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext("2d")
    if (!context) throw new Error("No canvas to redraw the image in")
    context.drawImage(bitmap, 0, 0)
    return await canvas.convertToBlob({ type: "image/png" })
  } finally {
    bitmap.close()
  }
}

/** Saves a copy of the file at `url` as `name`, through the window's own download, which asks where. */
export function saveFile(url: string, name: string): void {
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
}
