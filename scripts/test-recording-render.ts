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
      transparent ? "transparent" : "rgba"
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
        transparent ? "transparent" : "rgba"
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

// Independent full-frame libvips oracle for the opaque browser fast path.
// Include nonuniform colors, overlapping press/cursor alpha and clipped edges;
// checking only two optimized renders could conceal the same error in both.
const browserWidth = 320,
  browserHeight = 180
const browserPixels = Buffer.alloc(browserWidth * browserHeight * 3)
for (let index = 0; index < browserPixels.length; index++)
  browserPixels[index] = (index * 31 + Math.floor(index / 97)) % 256
const browserImage = await sharp(browserPixels, {
  raw: { width: browserWidth, height: browserHeight, channels: 3 },
})
  .png()
  .toBuffer()
const artwork = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="32"><circle cx="8" cy="8" r="6" fill="none" stroke="#efaa59" stroke-width="2"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="32" viewBox="0 0 28 32"><path d="M5 4v21l6-6 4 9 4-2-4-9h8L5 4Z" fill="#302c27" stroke="#fffaf3" stroke-width="1.7" stroke-linejoin="round"/></svg>',
]
const artworkPixels = await Promise.all(
  artwork.map((svg) => sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer())
)
for (const [x, y] of [
  [0, 0],
  [160, 90],
  [319, 179],
  [5, 4],
  [297, 150],
]) {
  for (const at of [100, 500]) {
    const point = { at: 0, x, y, pressed: true }
    const overlays = []
    for (const index of at < 400 ? [0, 1] : [1]) {
      const left = x - (index === 0 ? 3 : 5),
        top = y - 4
      const offsetX = Math.max(0, -left),
        offsetY = Math.max(0, -top)
      const width = Math.min(28 - offsetX, browserWidth - Math.max(0, left))
      const height = Math.min(32 - offsetY, browserHeight - Math.max(0, top))
      const input = await sharp(artworkPixels[index], {
        raw: { width: 28, height: 32, channels: 4 },
      })
        .extract({ left: offsetX, top: offsetY, width, height })
        .png()
        .toBuffer()
      overlays.push({ input, left: Math.max(0, left), top: Math.max(0, top) })
    }
    const expected = await sharp(browserImage)
      .ensureAlpha()
      .composite(overlays)
      .raw()
      .toBuffer()
    const actual = await renderRecordingImage(
      browserImage,
      { width: browserWidth, height: browserHeight },
      at,
      point,
      point,
      browserWidth,
      browserHeight
    )
    const rgb = await renderRecordingImage(
      browserImage,
      { width: browserWidth, height: browserHeight },
      at,
      point,
      point,
      browserWidth,
      browserHeight,
      "rgb"
    )
    const expectedRgb = await sharp(expected, {
      raw: { width: browserWidth, height: browserHeight, channels: 4 },
    })
      .removeAlpha()
      .raw()
      .toBuffer()
    assert.ok(
      rgb.equals(expectedRgb),
      `RGB pipe changes colors at ${x},${y},${at}`
    )
    assert.ok(
      actual.equals(expected),
      `Full-frame oracle differs at ${x},${y},${at}`
    )
  }
}
console.log(
  "Opaque cursor patches match the full-frame compositor byte-for-byte"
)
