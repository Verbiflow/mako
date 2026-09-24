import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifestPath = join(root, "vendor/control-media/sources.json")
const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
assert.equal(process.platform, "darwin", "This recipe currently builds macOS; Linux has a separate native runtime image")
assert.equal(process.arch, "arm64")
const supplied = process.argv[2]
const work = supplied ? resolve(supplied) : await mkdtemp(join(tmpdir(), "mako-media-build-"))
const prefix = join(work, "prefix")
const sources = join(work, "sources")
await mkdir(sources, { recursive: true })
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const run = (file, args, cwd = work, env = process.env) => execFileSync(file, args, { cwd, env, stdio: "inherit" })
for (const source of manifest.sources) {
  const archive = join(sources, source.archive)
  const bytes = await readFile(archive).catch((error) => {
    if (error.code !== "ENOENT") throw error
    return null
  })
  if (!bytes) run("curl", ["--fail", "--location", "--max-time", "120", source.url, "--output", archive])
  assert.equal(hash(bytes ?? await readFile(archive)), source.sha256, `Source hash mismatch: ${source.name}`)
  run("tar", ["-xf", archive, "-C", work])
}
const x264 = manifest.sources.find((source) => source.name === "x264")
const ffmpeg = manifest.sources.find((source) => source.name === "ffmpeg")
const x264Root = join(work, `x264-${x264.version}`)
const ffmpegRoot = join(work, `ffmpeg-${ffmpeg.version}`)
const x264Args = [`--prefix=${prefix}`, "--enable-static", "--disable-cli", "--disable-opencl", "--disable-lsmash", "--disable-swscale", "--disable-ffms", "--enable-pic"]
run("./configure", x264Args, x264Root)
run("make", ["-j4", "install"], x264Root)
const ffmpegArgs = [`--prefix=${prefix}`, "--disable-autodetect", "--disable-network", "--disable-doc", "--disable-debug", "--disable-ffplay", "--disable-shared", "--enable-static", "--enable-gpl", "--enable-libx264", "--pkg-config-flags=--static", "--disable-everything", "--enable-ffmpeg", "--enable-ffprobe", "--enable-avcodec", "--enable-avformat", "--enable-avfilter", "--enable-swscale", "--enable-protocol=file,pipe", "--enable-demuxer=concat,image2,mov,rawvideo", "--enable-decoder=png,mjpeg,h264,rawvideo", "--enable-parser=h264,png,mjpeg", "--enable-encoder=libx264,png", "--enable-muxer=mp4,image2", "--enable-filter=scale,pad,overlay,fps,format,null,copy,buffer,buffersink", "--enable-bsf=h264_mp4toannexb,extract_extradata", "--enable-zlib"]
run("./configure", ffmpegArgs, ffmpegRoot, { ...process.env, PKG_CONFIG_LIBDIR: join(prefix, "lib/pkgconfig") })
run("make", ["-j4"], ffmpegRoot)
const destination = join(root, "vendor/control-media/darwin-arm64")
const staging = await mkdtemp(join(root, "vendor/control-media/.build-"))
const binaries = {}
for (const name of ["ffmpeg", "ffprobe"]) {
  const source = join(ffmpegRoot, name)
  const deps = execFileSync("otool", ["-L", source], { encoding: "utf8" })
  for (const line of deps.split("\n").slice(1).filter((line) => line.trim())) {
    assert.match(line.trim(), /^(\/usr\/lib\/|\/System\/Library\/)/, `Non-system dynamic dependency: ${line}`)
  }
  run(source, ["-version"])
  await cp(source, join(staging, name))
  binaries[name] = hash(await readFile(source))
}
await cp(sources, join(staging, "sources"), { recursive: true })
await cp(join(ffmpegRoot, "COPYING.GPLv2"), join(staging, "COPYING.GPLv2"))
await cp(join(x264Root, "COPYING"), join(staging, "COPYING.x264"))
await cp(fileURLToPath(import.meta.url), join(staging, "build-control-media.mjs"))
await cp(manifestPath, join(staging, "sources.json"))
await writeFile(join(staging, "provenance.json"), JSON.stringify({ recipe: manifest.recipe, platform: process.platform, arch: process.arch, sources: manifest.sources, binaries, x264Args, ffmpegArgs }, null, 2) + "\n")
// A build is immutable; never overwrite a reviewed binary silently.
await rename(staging, destination)
console.log(`Built self-contained recording executables: ${destination}`)
