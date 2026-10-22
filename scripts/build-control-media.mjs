import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { availableParallelism, tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifestPath = join(root, "vendor/control-media/sources.json")
const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
const target = `${process.platform}-${process.arch}`
assert.ok(["darwin-arm64", "linux-x64"].includes(target), `This recipe builds darwin-arm64 and linux-x64, not ${target}`)
const mac = process.platform === "darwin"
const supplied = process.argv[2]
const work = supplied ? resolve(supplied) : await mkdtemp(join(tmpdir(), "mako-media-build-"))
const destination = process.argv[3] ? resolve(process.argv[3]) : join(root, "vendor/control-media", target)
const prefix = join(work, "prefix")
const sources = join(work, "sources")
const jobs = String(availableParallelism())
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
run("make", [`-j${jobs}`, "install"], x264Root)
// What recordings and live video ask of FFmpeg, and nothing else; ffprobe reads raw H.264 to check live units decode.
// Each is checked in the built binary below.
const components = {
  protocol: ["file", "pipe"],
  demuxer: ["image2", "mov", "rawvideo", "h264"],
  decoder: ["png", "mjpeg", "h264", "rawvideo"],
  parser: ["h264", "png", "mjpeg"],
  encoder: ["libx264", "png", ...(mac ? ["h264_videotoolbox"] : [])],
  muxer: ["mp4", "image2", "flv"],
  filter: ["scale", "pad", "tpad", "overlay", "fps", "format", "null", "copy", "buffer", "buffersink", "crop"],
  bsf: ["h264_mp4toannexb", "extract_extradata", "setts"],
}
const ffmpegArgs = [
  `--prefix=${prefix}`, "--disable-autodetect", "--disable-network", "--disable-doc", "--disable-debug", "--disable-ffplay",
  "--disable-shared", "--enable-static", "--enable-gpl", "--enable-libx264", "--pkg-config-flags=--static", "--disable-everything",
  "--enable-ffmpeg", "--enable-ffprobe", "--enable-avcodec", "--enable-avformat", "--enable-avfilter", "--enable-swscale",
  ...Object.entries(components).map(([kind, names]) => `--enable-${kind}=${names.join(",")}`),
  ...(mac ? ["--enable-videotoolbox"] : []),
  "--enable-zlib",
]
run("./configure", ffmpegArgs, ffmpegRoot, { ...process.env, PKG_CONFIG_LIBDIR: join(prefix, "lib/pkgconfig") })
run("make", [`-j${jobs}`], ffmpegRoot)
// Only the system's own libraries: the C library, and zlib, which every Mac and Debian has.
const system = mac ? /^(\/usr\/lib\/|\/System\/Library\/)/ : /^(linux-vdso\.so|\/lib64\/ld-linux|lib(c|m|z|dl|rt|pthread)\.so)/
const listed = { protocol: "-protocols", demuxer: "-demuxers", decoder: "-decoders", encoder: "-encoders", muxer: "-muxers", filter: "-filters", bsf: "-bsfs" }
const staging = await mkdtemp(join(root, "vendor/control-media/.build-"))
const binaries = {}
for (const name of ["ffmpeg", "ffprobe"]) {
  const source = join(ffmpegRoot, name)
  const deps = mac ? execFileSync("otool", ["-L", source], { encoding: "utf8" }).split("\n").slice(1) : execFileSync("ldd", [source], { encoding: "utf8" }).split("\n")
  for (const line of deps.filter((line) => line.trim())) assert.match(line.trim(), system, `Non-system dynamic dependency: ${line}`)
  run(source, ["-version"])
  await cp(source, join(staging, name))
  binaries[name] = hash(await readFile(source))
}
for (const [kind, flag] of Object.entries(listed)) {
  const output = execFileSync(join(ffmpegRoot, "ffmpeg"), ["-hide_banner", flag], { encoding: "utf8" })
  // A format lists every name it answers to, such as `mov,mp4,m4a`.
  for (const name of components[kind]) assert.match(output, new RegExp(`(^|[\\s,])${name}([\\s,]|$)`, "m"), `The build lacks the ${name} ${kind}`)
}
await cp(sources, join(staging, "sources"), { recursive: true })
await cp(join(ffmpegRoot, "COPYING.GPLv2"), join(staging, "COPYING.GPLv2"))
await cp(join(x264Root, "COPYING"), join(staging, "COPYING.x264"))
await cp(fileURLToPath(import.meta.url), join(staging, "build-control-media.mjs"))
await cp(manifestPath, join(staging, "sources.json"))
await writeFile(join(staging, "provenance.json"), JSON.stringify({ recipe: manifest.recipe, platform: process.platform, arch: process.arch, sources: manifest.sources, binaries, x264Args, ffmpegArgs }, null, 2) + "\n")
// A build is immutable: an earlier one is replaced only in the open, named with its recipe, and only once this one
// is whole, so a stop at any point leaves one complete build in place.
const earlier = await readFile(join(destination, "provenance.json"), "utf8").then((text) => JSON.parse(text), () => undefined)
const replaced = `${destination}.replaced-${Date.now().toString(36)}`
if (earlier !== undefined || (await readdir(destination).then(() => true, () => false))) {
  console.log(`Replacing the recording executables built for recipe ${earlier?.recipe ?? "unknown"} with recipe ${manifest.recipe}'s`)
  await rename(destination, replaced)
}
await rename(staging, destination)
await rm(replaced, { recursive: true, force: true })
console.log(`Built self-contained recording executables: ${destination}`)
