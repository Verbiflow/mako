import assert from "node:assert/strict"
import sharp from "sharp"
import { renderRecordingImage } from "../packages/control-runtime/src/recording-render.js"

// Compare clipped artwork with an independently cropped interior rendering.
// This catches stride/edge errors in the raw cursor path without freezing codec
// or SVG rasterizer hashes across operating systems.
for (const transparent of [false, true]) {
  const source = await sharp({
    create: {
      width: 128,
      height: 128,
      channels: 4,
      background: { r: 30, g: 45, b: 60, alpha: transparent ? 0 : 1 },
    },
  })
    .png()
    .toBuffer()
  const point = { at: 0, x: 64, y: 64, pressed: true }
  for (const at of [100, 500]) {
    const full = await renderRecordingImage(
      source,
      { width: 128, height: 128 },
      at,
      point,
      point,
      128,
      128,
      transparent
    )
    for (const [x, y] of [
      [0, 0],
      [1, 1],
      [31, 0],
      [0, 31],
      [31, 31],
      [16, 16],
    ]) {
      const cursor = { ...point, x, y }
      const edge = await renderRecordingImage(
        source,
        { width: 32, height: 32 },
        at,
        cursor,
        cursor,
        32,
        32,
        transparent
      )
      const expected = await sharp(full, {
        raw: { width: 128, height: 128, channels: 4 },
      })
        .extract({ left: 64 - x, top: 64 - y, width: 32, height: 32 })
        .raw()
        .toBuffer()
      assert.deepEqual(
        edge,
        expected,
        JSON.stringify({ transparent, at, x, y })
      )
    }
  }
}
console.log(
  "Recording cursor/ring clipping and transparent native overlays pass"
)
