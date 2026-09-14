import { writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

/**
 * The browser icon set, drawn from the desktop icon's own mark.
 *
 * The app icon carries the fin at about 46% of its canvas because a dock tile
 * is 128px and can afford the air. A tab favicon is 16px: the same artwork
 * downscaled left a dark square with a four-pixel smudge in it. So the tile
 * here is the desktop icon's ground and the same fin, scaled to fill it, in
 * one flat silver gradient — an edge highlight or a cast shadow is sub-pixel
 * noise at this size.
 *
 * The silhouette is traced from `mako-icons/_masters` (the menubar glyph is
 * the master's own fin with no lighting): two cubics fitted to the leading and
 * trailing edges, within 0.15% of the traced outline, in a 100x100 box that is
 * `FIN_ASPECT` wider than it is tall.
 */
const FIN_ASPECT = 1.0375
/**
 * The master centres the fin vertically and leaves a little more air on its
 * left than its right, which is the shape's own mass asking for it: the
 * centroid sits at 43% across its bounding box.
 */
const FIN_LEFT_SHARE = 0.54
const FIN_EDGES = {
  leading: [
    [43.75, 5.86],
    [69.69, 39.84],
  ],
  trailing: [
    [14, 79.69],
    [25.91, 40.16],
  ],
}

/** The icon's own coordinate space; every size is this one rasterized. */
const CANVAS = 32

/**
 * The kit's two treatments, sampled from `desktop-gradient.png` and
 * `desktop-light.png`: a dark ground under a silver fin, and the aluminium
 * ground under a graphite one. They are the mark's own light and dark, which
 * is also the widest a tab strip can tell two of them apart.
 */
const DARK = {
  ground: ["#2b3134", "#14181b"],
  sheen: { color: "#6a7276", opacity: 0.5 },
  fin: ["#ffffff", "#e8edef", "#a8b2b7"],
}
const LIGHT = {
  ground: ["#f6f6f4", "#bcbcb9"],
  sheen: { color: "#ffffff", opacity: 0.55 },
  fin: ["#4b5154", "#2b3134", "#14181b"],
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const iconsDirectory = join(root, "public", "icons")

const round = (value) => Math.round(value * 100) / 100

function finPath({ inset }) {
  const width = CANVAS - inset * 2
  const height = width / FIN_ASPECT
  const left = inset * 2 * FIN_LEFT_SHARE
  const top = (CANVAS - height) / 2
  const x = (u) => round(left + (u / 100) * width)
  const y = (v) => round(top + (v / 100) * height)
  const [lead1, lead2] = FIN_EDGES.leading
  const [back1, back2] = FIN_EDGES.trailing
  return [
    `M${x(0)} ${y(0)}`,
    `C${x(lead1[0])} ${y(lead1[1])} ${x(lead2[0])} ${y(lead2[1])} ${x(100)} ${y(100)}`,
    `L${x(0)} ${y(100)}`,
    `C${x(back1[0])} ${y(back1[1])} ${x(back2[0])} ${y(back2[1])} ${x(0)} ${y(0)}`,
    "Z",
  ].join("")
}

/**
 * @param {{ treatment: typeof DARK, radius: number, inset: number, size?: number }} options
 */
function markSvg({ treatment, radius, inset, size }) {
  const dimensions = size ? ` width="${size}" height="${size}"` : ""
  const [groundTop, groundBottom] = treatment.ground
  const [finLight, finMid, finDeep] = treatment.fin
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}"${dimensions}>
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="${CANVAS}" gradientUnits="userSpaceOnUse">
      <stop stop-color="${groundTop}" />
      <stop offset="1" stop-color="${groundBottom}" />
    </linearGradient>
    <radialGradient id="sheen" cx="16" cy="3" r="22" gradientUnits="userSpaceOnUse">
      <stop stop-color="${treatment.sheen.color}" stop-opacity="${treatment.sheen.opacity}" />
      <stop offset="1" stop-color="${treatment.sheen.color}" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="fin" x1="9" y1="5" x2="25" y2="27" gradientUnits="userSpaceOnUse">
      <stop stop-color="${finLight}" />
      <stop offset=".5" stop-color="${finMid}" />
      <stop offset="1" stop-color="${finDeep}" />
    </linearGradient>
  </defs>
  <rect width="${CANVAS}" height="${CANVAS}" rx="${radius}" fill="url(#ground)" />
  <rect width="${CANVAS}" height="${CANVAS}" rx="${radius}" fill="url(#sheen)" />
  <path fill="url(#fin)" d="${finPath({ inset })}" />
</svg>
`
}

/**
 * Rasterize the vector at eight times the target and reduce, which keeps the
 * fin's trailing edge from washing out at 16px the way a direct render does.
 */
async function rasterize(svg, size) {
  const supersample = Math.min(size * 8, 1024)
  return await sharp(Buffer.from(markSvg({ ...svg, size: supersample })))
    .resize(size, size, { kernel: "lanczos3" })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer()
}

/** An ICO holding PNG-compressed entries, which every current browser reads. */
function icoFile(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const directory = []
  let offset = header.length + entries.length * 16
  for (const { size, png } of entries) {
    const record = Buffer.alloc(16)
    record.writeUInt8(size, 0)
    record.writeUInt8(size, 1)
    record.writeUInt16LE(1, 4)
    record.writeUInt16LE(32, 6)
    record.writeUInt32LE(png.length, 8)
    record.writeUInt32LE(offset, 12)
    offset += png.length
    directory.push(record)
  }
  return Buffer.concat([header, ...directory, ...entries.map((entry) => entry.png)])
}

async function writeSet({ name, treatment }) {
  const tile = { treatment, radius: 7, inset: 4.6 }
  await writeFile(join(iconsDirectory, `${name}.svg`), markSvg(tile))
  const sizes = [16, 32, 48]
  const rendered = []
  for (const size of sizes) rendered.push({ size, png: await rasterize(tile, size) })
  await writeFile(join(iconsDirectory, `${name}.ico`), icoFile(rendered))
  return rendered
}

const production = await writeSet({ name: "favicon", treatment: DARK })
for (const { size, png } of production) {
  if (size !== 48) await writeFile(join(iconsDirectory, `favicon-${size}.png`), png)
}
await writeSet({ name: "favicon-dev", treatment: LIGHT })

// iOS masks the home-screen icon itself, so this one is square and keeps the
// desktop icon's wider margin.
await writeFile(
  join(iconsDirectory, "apple-touch-180.png"),
  await rasterize({ treatment: DARK, radius: 0, inset: 6.2 }, 180)
)
