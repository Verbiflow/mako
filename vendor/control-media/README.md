# Recording media

`sources.json` pins the source archives and checksums. The build recipe is
`scripts/build-control-media.mjs`; run `npm run prepare:control-media` on macOS
ARM64. It builds FFmpeg/ffprobe with only the codecs, filters and file protocols
used by recordings. Network protocols and autodetected Homebrew libraries are
disabled. Recipe 3 introduced Apple's VideoToolbox H.264 encoder; recipe 4 removes
the unused concat demuxer after retiring staged-image browser recording. Mac
recordings require hardware (`allow_sw=0`), realtime mode, no B-frames and quality
85; unsupported builds refuse before capture. Native video that needs no transform
still passes through. Linux retains its existing x264 settings pending cloud design.

For a reviewable candidate without replacing an existing build:
`node scripts/build-control-media.mjs <work-directory> vendor/control-media/darwin-arm64-hardware`.
The optional destination is immutable, like the default destination. Promote it to
`darwin-arm64` only after recording, recovery and quality validation. The packager
rejects binaries whose recipe no longer matches `sources.json`.

Generated `<platform>-<arch>/` directories are ignored by Git. They contain
executables, hashes, the exact source archives, license texts and a copy of the
recipe. The Mac packager verifies binary hashes before signing, checks system-only
dynamic dependencies after signing and includes the source/license artifacts.
Do not remove those artifacts as a size optimization.

Currently built: `darwin-arm64`. Linux acceptance images supply FFmpeg from their
distribution; that is not a standalone bundled Linux media release. Linux x64,
Linux ARM64 standalone media, and Intel Mac require their own build recipe and
packaged recording acceptance before being advertised as complete targets.
