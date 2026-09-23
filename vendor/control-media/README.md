# Recording media

`sources.json` pins the source archives and checksums. The build recipe is
`scripts/build-control-media.mjs`; run `npm run prepare:control-media` on macOS
ARM64. It builds FFmpeg/ffprobe with only the codecs, filters and file protocols
used by recordings. Network protocols and autodetected Homebrew libraries are
disabled. Video quality remains the recording API's existing H.264 settings.

Generated `<platform>-<arch>/` directories are ignored by Git. They contain
executables, hashes, the exact source archives, license texts and a copy of the
recipe. The Mac packager verifies binary hashes before signing, checks system-only
dynamic dependencies after signing and includes the source/license artifacts.
Do not remove those artifacts as a size optimization.

Currently built: `darwin-arm64`. Linux acceptance images supply FFmpeg from their
distribution; that is not a standalone bundled Linux media release. Linux x64,
Linux ARM64 standalone media, and Intel Mac require their own build recipe and
packaged recording acceptance before being advertised as complete targets.
