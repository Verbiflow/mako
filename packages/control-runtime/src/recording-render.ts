import sharp, { type OverlayOptions } from "sharp"
import { z } from "zod"

const pointer = z.object({
  at: z.number(),
  x: z.number(),
  y: z.number(),
  pressed: z.boolean(),
})
export const RecordingRenderSchema = z.object({
  at: z.number().nonnegative(),
  frame: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
    viewportWidth: z.number().positive().optional(),
    viewportHeight: z.number().positive().optional(),
    pageScaleFactor: z.number().positive().optional(),
    offsetTop: z.number().optional(),
  }),
  pointer: pointer.optional(),
  press: pointer.optional(),
})
export type RecordingRender = z.infer<typeof RecordingRenderSchema>

const pointerArtwork = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="32" viewBox="0 0 28 32"><path d="M5 4v21l6-6 4 9 4-2-4-9h8L5 4Z" fill="#302c27" stroke="#fffaf3" stroke-width="1.7" stroke-linejoin="round"/></svg>'
)
const pressArtwork = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="32"><circle cx="8" cy="8" r="6" fill="none" stroke="#efaa59" stroke-width="2"/></svg>'
)
let artwork: Promise<{ pointer: Buffer; press: Buffer }> | undefined

// These two fixed images occupy 7 KiB. Rasterize only when a recording first
// needs its cursor, rather than decoding SVG and encoding PNG every frame.
function cursorPixels() {
  return (artwork ??= Promise.all(
    [pointerArtwork, pressArtwork].map((input) =>
      sharp(input).ensureAlpha().raw().toBuffer()
    )
  ).then(([pointer, press]) => ({ pointer, press })))
}

function cursorOverlay(
  input: Buffer,
  left: number,
  top: number,
  width: number,
  height: number
): OverlayOptions | undefined {
  const offsetX = Math.max(0, -left)
  const offsetY = Math.max(0, -top)
  const visibleWidth = Math.min(28 - offsetX, width - Math.max(0, left))
  const visibleHeight = Math.min(32 - offsetY, height - Math.max(0, top))
  if (visibleWidth <= 0 || visibleHeight <= 0) return
  let pixels = input
  if (visibleWidth !== 28 || visibleHeight !== 32) {
    pixels = Buffer.allocUnsafe(visibleWidth * visibleHeight * 4)
    for (let row = 0; row < visibleHeight; row++) {
      const start = ((row + offsetY) * 28 + offsetX) * 4
      input.copy(
        pixels,
        row * visibleWidth * 4,
        start,
        start + visibleWidth * 4
      )
    }
  }
  return {
    input: pixels,
    raw: { width: visibleWidth, height: visibleHeight, channels: 4 },
    left: Math.max(0, left),
    top: Math.max(0, top),
  }
}

/** Shared pixel composition for continuous browser encoding and native overlays. */
export async function renderRecordingImage(
  bytes: Buffer,
  frame: RecordingRender["frame"],
  at: number,
  pointer: RecordingRender["pointer"],
  press: RecordingRender["press"],
  width: number,
  height: number,
  transparent = false
) {
  const image = sharp(bytes).resize(width, height, {
    fit: "contain",
    background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : "#171614",
  })
  const overlays: OverlayOptions[] = []
  if (pointer) {
    const viewportWidth = frame.viewportWidth ?? frame.width
    const viewportHeight = frame.viewportHeight ?? frame.height
    const scale = Math.min(width / viewportWidth, height / viewportHeight)
    const x = Math.round(
      pointer.x * (frame.pageScaleFactor ?? 1) * scale +
        (width - viewportWidth * scale) / 2
    )
    const y = Math.round(
      (pointer.y * (frame.pageScaleFactor ?? 1) + (frame.offsetTop ?? 0)) *
        scale +
        (height - viewportHeight * scale) / 2
    )
    if (x >= 0 && y >= 0 && x < width && y < height) {
      const pixels = await cursorPixels()
      const addOverlay = (input: Buffer, left: number, top: number) => {
        const overlay = cursorOverlay(input, left, top, width, height)
        if (overlay) overlays.push(overlay)
      }
      if (
        press &&
        at - press.at < 400 &&
        press.x === pointer.x &&
        press.y === pointer.y
      ) {
        addOverlay(pixels.press, x - 3, y - 4)
      }
      addOverlay(pixels.pointer, x - 5, y - 4)
    }
  }
  return image.ensureAlpha().composite(overlays).raw().toBuffer()
}
