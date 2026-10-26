import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { PAGE_HEIGHT_MESSAGE } from "@mako/host/contracts/page-frame"
import { filePolicyHeaders, fitPage, INERT_POLICY, PAGE_POLICY, SVG_POLICY } from "@mako/host/base/file-policy"
import { ArtifactPreviews } from "@mako/host/workspaces/artifact-previews"
import { FILE_PREVIEW_TTL_MS, fileIdentity, filePreviewUrl, verifyFilePreview } from "@mako/host/workspaces/file-previews"
import { fileResponse, localFile } from "@mako/host/workspaces/file-response"
import { ConversationFiles } from "@mako/host/workspaces/files"
import { mediaDimensions } from "@mako/host/workspaces/media-dimensions"
import { MediaRenditions } from "@mako/host/workspaces/media-renditions"

/**
 * How the host serves what a transcript shows: signed URLs that expire and
 * stop working when the file changes, a page's folder grant and what it
 * refuses, what each type may do once loaded, a page's height reporter,
 * sizes read from headers alone, posters and thumbnails, and previews that
 * stay links outside the Thread's folders.
 */
const root = await realpath(await mkdtemp(join(tmpdir(), "mako-media-serving-")))
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXZkAAAAASUVORK5CYII=", "base64")

/** A PNG header stating `width` by `height`; the size check reads nothing past IHDR. */
function pngHeader(width: number, height: number): Buffer {
  const head = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head)
  head.writeUInt32BE(13, 8)
  head.write("IHDR", 12, "ascii")
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return head
}

function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length, 0)
  head.write(type, 4, "ascii")
  return Buffer.concat([head, body])
}

/** An MP4 whose `moov` comes after its `mdat`, as recorders write it, with one track of the given size. */
function mp4(width: number, height: number, quarterTurn = false): Buffer {
  const tkhd = Buffer.alloc(84)
  const matrix = 84 - 8 - 36
  if (quarterTurn) {
    tkhd.writeInt32BE(0, matrix)
    tkhd.writeInt32BE(0x10000, matrix + 4)
    tkhd.writeInt32BE(-0x10000, matrix + 12)
    tkhd.writeInt32BE(0, matrix + 16)
  } else {
    tkhd.writeInt32BE(0x10000, matrix)
    tkhd.writeInt32BE(0x10000, matrix + 16)
  }
  tkhd.writeUInt32BE(width * 65_536, 76)
  tkhd.writeUInt32BE(height * 65_536, 80)
  const audio = box("trak", box("tkhd", Buffer.alloc(84)))
  return Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("mdat", Buffer.alloc(4096)), box("moov", box("mvhd", Buffer.alloc(100)), audio, box("trak", box("tkhd", tkhd)))])
}

async function dimensionsOf(path: string, mimeType: string) {
  const file = await open(path, "r")
  try {
    const size = (await file.stat()).size
    const head = Buffer.alloc(Math.min(size, 4096))
    await file.read(head, 0, head.length, 0)
    return await mediaDimensions(file, head, size, mimeType)
  } finally {
    await file.close()
  }
}

try {
  // Signed URLs: the file they were signed for, until it changes or the hour is up.
  const shot = join(root, "shot.png")
  await writeFile(shot, PNG_1x1)
  const signed = filePreviewUrl(shot, fileIdentity(await stat(shot)))
  assert.match(signed, /^mako-file:\/\/asset\/[\w-]+\/[a-f0-9]{64}\/shot\.png$/)
  assert.deepEqual(await verifyFilePreview(signed), { kind: "file", path: shot, entry: true })
  assert.deepEqual(await verifyFilePreview(signed.replace(/\/shot\.png$/, "")), { kind: "file", path: shot, entry: true }, "the trailing name is optional")
  assert.deepEqual(await verifyFilePreview(signed, Date.now() + FILE_PREVIEW_TTL_MS + 1_000), { kind: "refused", reason: "expired" })
  const [prefix, payload, signature] = /^(mako-file:\/\/asset\/)([\w-]+)\/([a-f0-9]{64})/.exec(signed)!.slice(1)
  const forged: unknown = JSON.parse(Buffer.from(payload!, "base64url").toString())
  assert.ok(Array.isArray(forged))
  forged[1] = Date.now() + 365 * 86_400_000
  assert.deepEqual(await verifyFilePreview(`${prefix}${Buffer.from(JSON.stringify(forged)).toString("base64url")}/${signature}/shot.png`), { kind: "invalid" }, "a payload can't be edited under its signature")
  assert.deepEqual(await verifyFilePreview("mako-file://asset/not-base64/" + "a".repeat(64)), { kind: "invalid" })
  // Rewritten in place (same inode, new bytes and time): refused.
  await writeFile(shot, Buffer.concat([PNG_1x1, Buffer.from("more")]))
  assert.deepEqual(await verifyFilePreview(signed), { kind: "refused", reason: "changed" })
  // Replaced by another file at the same path (written beside it, renamed over it), even of the same size and time: refused by its inode.
  const again = filePreviewUrl(shot, fileIdentity(await stat(shot)))
  const before = await stat(shot)
  await writeFile(join(root, "shot.next"), await readFile(shot))
  await utimes(join(root, "shot.next"), before.atime, before.mtime)
  await rename(join(root, "shot.next"), shot)
  assert.notEqual((await stat(shot)).ino, before.ino)
  assert.equal((await stat(shot)).size, before.size)
  assert.deepEqual(await verifyFilePreview(again), { kind: "refused", reason: "changed" })
  await rm(shot)
  assert.deepEqual(await verifyFilePreview(again), { kind: "refused", reason: "changed" }, "a deleted file is no longer served")

  // A page's folder grant: what it links beside it, of the types a page uses, and nothing else.
  const site = join(root, "site")
  await mkdir(join(site, "assets", "fonts"), { recursive: true })
  await writeFile(join(site, "index.html"), "<!doctype html><html><head><link rel=stylesheet href=style.css></head><body><img src=assets/hero.png></body></html>")
  await writeFile(join(site, "style.css"), "body{margin:0}")
  await writeFile(join(site, "assets", "hero.png"), PNG_1x1)
  await writeFile(join(site, "assets", "fonts", "inter.woff2"), "font")
  await writeFile(join(site, "notes.txt"), "not an asset")
  await writeFile(join(site, ".env"), "SECRET=1")
  await writeFile(join(root, "outside.css"), "body{}")
  await symlink(join(root, "outside.css"), join(site, "escape.css"))
  const page = filePreviewUrl(join(site, "index.html"), fileIdentity(await stat(join(site, "index.html"))), { folder: true })
  const asset = (relative: string) => page.replace(/\/index\.html$/, `/${relative}`)
  assert.deepEqual(await verifyFilePreview(page), { kind: "file", path: join(site, "index.html"), entry: true })
  assert.deepEqual(await verifyFilePreview(asset("style.css")), { kind: "file", path: join(site, "style.css"), entry: false })
  assert.deepEqual(await verifyFilePreview(asset("assets/hero.png")), { kind: "file", path: join(site, "assets", "hero.png"), entry: false })
  assert.deepEqual(await verifyFilePreview(asset("assets/fonts/inter.woff2")), { kind: "file", path: join(site, "assets", "fonts", "inter.woff2"), entry: false })
  assert.deepEqual(await verifyFilePreview(asset("notes.txt")), { kind: "refused", reason: "type" })
  assert.deepEqual(await verifyFilePreview(asset(".env")), { kind: "refused", reason: "outside" })
  assert.deepEqual(await verifyFilePreview(asset("..%2Foutside.css")), { kind: "refused", reason: "outside" })
  // A literal `..` is resolved by the URL itself, which then climbs out of its own signature.
  assert.deepEqual(await verifyFilePreview(asset("../outside.css")), { kind: "invalid" })
  assert.deepEqual(await verifyFilePreview(asset("escape.css")), { kind: "refused", reason: "outside" }, "a symlink out of the folder is refused")
  assert.deepEqual(await verifyFilePreview(asset("missing.css")), { kind: "refused", reason: "outside" })
  const lone = filePreviewUrl(join(site, "style.css"), fileIdentity(await stat(join(site, "style.css"))))
  assert.deepEqual(await verifyFilePreview(lone.replace(/\/style\.css$/, "/index.html")), { kind: "invalid" }, "a file's URL is no grant on its folder")

  // What each type may do once loaded.
  for (const type of ["image/png", "image/jpeg", "video/mp4", "audio/mpeg", "font/woff2"])
    assert.deepEqual(filePolicyHeaders(type), { "x-content-type-options": "nosniff" }, `${type} carries no policy`)
  assert.equal(filePolicyHeaders("image/svg+xml")["content-security-policy"], SVG_POLICY)
  assert.equal(SVG_POLICY, "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  assert.equal(filePolicyHeaders("text/html; charset=utf-8")["content-security-policy"], PAGE_POLICY)
  assert.equal(PAGE_POLICY, "sandbox allow-scripts allow-forms allow-popups")
  for (const type of ["text/plain", "application/json", "text/css", "text/javascript", "application/pdf", undefined])
    assert.equal(filePolicyHeaders(type)["content-security-policy"], INERT_POLICY, `${type} is inert opened directly`)
  for (const type of ["image/png", "text/html", undefined]) assert.equal(filePolicyHeaders(type)["x-content-type-options"], "nosniff")

  // A page reports its height first thing, spliced in by bytes, never re-encoded.
  const latin = Buffer.concat([Buffer.from("<!DOCTYPE html><html><HEAD lang=fr><meta charset=iso-8859-1></HEAD><body>caf"), Buffer.from([0xe9]), Buffer.from("</body></html>")])
  const fitted = fitPage(latin)
  assert.ok(fitted.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9])), "the page's own bytes stay")
  assert.ok(fitted.toString("latin1").startsWith("<!DOCTYPE html><html><HEAD lang=fr><script>"))
  assert.ok(fitted.toString("latin1").includes(PAGE_HEIGHT_MESSAGE))
  assert.ok(fitPage(Buffer.from("<!doctype html><p>bare")).toString().startsWith("<!doctype html><script>"))
  assert.ok(fitPage(Buffer.from("<p>fragment")).toString().startsWith("<script>"))
  const served = await fileResponse(await localFile(join(site, "index.html")), join(site, "index.html"), new Request("http://local/page", { headers: { range: "bytes=0-9" } }), { cacheable: true })
  const body = await served.text()
  assert.equal(served.status, 200, "a page is served whole, never a range")
  assert.equal(served.headers.get("content-type"), "text/html")
  assert.equal(Number(served.headers.get("content-length")), Buffer.byteLength(body))
  assert.match(body, /^<!doctype html><html><head><script>/)
  const font = await fileResponse(await localFile(join(site, "assets", "fonts", "inter.woff2")), join(site, "assets", "fonts", "inter.woff2"), new Request("http://local/font"), { cacheable: true, crossOrigin: true })
  assert.equal(font.headers.get("access-control-allow-origin"), "*", "a sandboxed page's fonts and modules load across its opaque origin")
  await font.body?.cancel()
  const picture = await fileResponse(await localFile(join(site, "assets", "hero.png")), join(site, "assets", "hero.png"), new Request("http://local/picture"), { cacheable: true })
  assert.equal(picture.headers.get("cache-control"), "private, max-age=3600", "a signed version may be kept")
  assert.equal(picture.headers.get("access-control-allow-origin"), null)
  await picture.body?.cancel()

  // Sizes from headers alone.
  const sizes: [string, Buffer, string, { width: number; height: number } | undefined][] = [
    ["wide.png", pngHeader(2880, 1800), "image/png", { width: 2880, height: 1800 }],
    ["tiny.png", PNG_1x1, "image/png", { width: 1, height: 1 }],
    ["anim.gif", Buffer.from("474946383961400120000000", "hex"), "image/gif", { width: 320, height: 32 }],
    ["vector.svg", Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630"><rect/></svg>'), "image/svg+xml", { width: 1200, height: 630 }],
    ["sized.svg", Buffer.from('<svg width="640px" height="320" xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml", { width: 640, height: 320 }],
    ["recording.mp4", mp4(1920, 1080), "video/mp4", { width: 1920, height: 1080 }],
    ["portrait.mp4", mp4(1920, 1080, true), "video/mp4", { width: 1080, height: 1920 }],
    ["broken.mp4", Buffer.from("not a video at all"), "video/mp4", undefined],
    ["huge.png", pngHeader(1 << 20, 10), "image/png", undefined],
  ]
  // A JPEG whose size sits past a 6 KB EXIF block, beyond the first read.
  const exif = Buffer.alloc(6000 + 4)
  exif.writeUInt16BE(0xffe1, 0)
  exif.writeUInt16BE(6002, 2)
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x84, 0x05, 0xa0])
  sizes.push(["photo.jpg", Buffer.concat([Buffer.from([0xff, 0xd8]), exif, sof, Buffer.alloc(64)]), "image/jpeg", { width: 1440, height: 900 }])
  const webp = Buffer.alloc(30)
  webp.write("RIFF", 0, "ascii")
  webp.write("WEBPVP8X", 8, "ascii")
  webp.writeUIntLE(799, 24, 3)
  webp.writeUIntLE(599, 27, 3)
  sizes.push(["photo.webp", webp, "image/webp", { width: 800, height: 600 }])
  for (const [name, bytes, mimeType, expected] of sizes) {
    await writeFile(join(root, name), bytes)
    assert.deepEqual(await dimensionsOf(join(root, name), mimeType), expected, name)
  }

  // A transcript's previews: sizes and posters come back with the read; outside the Thread's folders only media, pages and PDFs are read.
  const project = join(root, "project")
  const elsewhere = join(root, "elsewhere")
  const data = join(root, "thread-data")
  await mkdir(project)
  await mkdir(elsewhere)
  await mkdir(data)
  execFileSync("git", ["init", "-q", project])
  await writeFile(join(elsewhere, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n")
  await writeFile(join(elsewhere, "requests.har"), "{\"log\":{\"entries\":[]}}")
  await writeFile(join(elsewhere, "shot.png"), pngHeader(2880, 1800))
  await writeFile(join(elsewhere, "report.html"), "<!doctype html><title>Report</title>")
  await writeFile(join(elsewhere, "recording.mp4"), mp4(1280, 720))
  await writeFile(join(data, "notes.md"), "# Notes")
  await writeFile(join(project, "notes.txt"), "inside")
  const files = new ConversationFiles(new Git(), new ArtifactPreviews(() => []))
  const preview = (path: string) => files.read(project, path, async () => data, "preview")
  for (const secret of ["id_rsa", "requests.har"]) {
    const withheld = await preview(join(elsewhere, secret))
    assert.match(withheld.withheld ?? "", /outside this Thread's folders/, secret)
    assert.equal(withheld.contents, "")
    assert.equal(withheld.previewUrl, undefined)
  }
  assert.equal((await files.read(project, join(elsewhere, "id_rsa"))).contents, "-----BEGIN OPENSSH PRIVATE KEY-----\n", "opening it on purpose still reads it")
  assert.equal((await preview("notes.txt")).contents, "inside")
  assert.equal((await preview(join(data, "notes.md"))).contents, "# Notes", "the Thread's data folder is its own")
  const image = await preview(join(elsewhere, "shot.png"))
  assert.equal(image.withheld, undefined)
  assert.equal(image.width, 2880)
  assert.equal(image.height, 1800)
  assert.match(image.thumbnailUrl ?? "", /\?rendition=thumbnail$/)
  const video = await preview(join(elsewhere, "recording.mp4"))
  assert.deepEqual([video.media, video.width, video.height], ["video", 1280, 720])
  assert.match(video.posterUrl ?? "", /\?rendition=poster$/)
  const report = await preview(join(elsewhere, "report.html"))
  assert.equal(report.mimeType, "text/html")
  assert.ok(report.previewUrl && (await verifyFilePreview(report.previewUrl)).kind === "file", "a page comes with its folder grant")

  // Posters and thumbnails, once per file version, when this machine has ffmpeg.
  let ffmpeg: string | undefined
  try {
    ffmpeg = execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim() || undefined
  } catch {
    ffmpeg = undefined
  }
  if (ffmpeg) {
    const clip = join(root, "clip.mp4")
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=10:duration=1", "-pix_fmt", "yuv420p", "-y", clip])
    const still = join(root, "still.png")
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=1920x1200", "-frames:v", "1", "-y", still])
    let runs = 0
    const renditions = new MediaRenditions({ folder: join(root, "renditions"), ffmpeg: () => { runs += 1; return ffmpeg! } })
    const posterPath = await renditions.rendition(clip, fileIdentity(await stat(clip)), "poster")
    assert.ok(posterPath?.endsWith(".jpg"))
    assert.deepEqual(await dimensionsOf(posterPath!, "image/jpeg"), { width: 640, height: 360 })
    const thumbnail = await renditions.rendition(still, fileIdentity(await stat(still)), "thumbnail")
    assert.deepEqual(await dimensionsOf(thumbnail!, "image/png"), { width: 640, height: 400 }, "a thumbnail keeps its picture's shape")
    const [one, two] = await Promise.all([0, 1].map(async () => renditions.rendition(still, fileIdentity(await stat(still)), "thumbnail")))
    assert.equal(one, thumbnail)
    assert.equal(two, thumbnail)
    assert.equal(runs, 2, "a kept rendition runs no ffmpeg")
    const none = new MediaRenditions({ folder: join(root, "none"), ffmpeg: () => { throw new Error("no ffmpeg") } })
    assert.equal(await none.rendition(clip, fileIdentity(await stat(clip)), "poster"), null)
    assert.equal(await renditions.rendition(join(root, "broken.mp4"), fileIdentity(await stat(join(root, "broken.mp4"))), "poster"), null)
  } else console.log("ffmpeg isn't on PATH here; posters and thumbnails weren't made")

  console.log("Media serving: signed URLs expire and pin the file, page grants serve only their assets, each type carries its policy, pages fit their frames, sizes come from headers, previews outside the Thread's folders stay links")
} finally {
  await rm(root, { recursive: true, force: true })
}
