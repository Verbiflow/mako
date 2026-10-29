# Recording media

`sources.json` pins the source archives and checksums. Each source lists the
URLs that serve it, mirrors first and its project's own host last; the sha256
alone decides whether the bytes are the source, so a mirror is as safe as the
origin, and a host that is down or serves other bytes only moves the fetch to
the next URL (`scripts/lib/control-media-sources.mjs`). FFmpeg's release comes
from Debian's snapshot archive (content-addressed, permanent), then Alpine's
distfiles, then ffmpeg.org. x264's GitLab archive has no byte-identical mirror,
so it has its origin alone. Verified archives are kept in the ignored
`downloads/`, so a checkout downloads each once; `node
scripts/fetch-control-media-sources.mjs` fetches them alone. The Linux host
image's context carries them and its media build has no network; CI restores
them from its cache before building it. A new source or version adds its
mirrors' URLs only after checking that each serves bytes with its sha256.

The build recipe is
`scripts/build-control-media.mjs`; run `npm run prepare:control-media` on macOS
ARM64, and the Linux host image (`runtime/host/Dockerfile`) runs the same recipe
for Linux x64. It builds FFmpeg/ffprobe with only the codecs, filters and file
protocols used by recordings and live video, and checks each of them in the built
binary. Network protocols and autodetected libraries are disabled. Recipe 3
introduced Apple's VideoToolbox H.264 encoder; recipe 4 removes the unused concat
demuxer after retiring staged-image browser recording. Recipe 5 adds the `setts`
bitstream filter, which cuts idle time from native video without re-encoding, and
the `tpad` filter, which holds a native video's last frame under the pointer
overlay. Recipe 6 adds the `flv` muxer and the `crop` filter, which live video to
remote viewers uses, the `h264` demuxer, with which ffprobe checks that live units
decode, and builds Linux x64. Mac recordings require hardware
(`allow_sw=0`), realtime mode, no B-frames and quality 85; unsupported builds
refuse before capture. Native video that needs no transform still passes through.
Linux encodes with x264.

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

Built: `darwin-arm64`, and `linux-x64` inside the Linux host image, which installs
it at `/opt/mako/vendor/control-media/linux-x64` where the host finds it. Linux
ARM64 and Intel Mac need their own acceptance before being advertised as targets.
