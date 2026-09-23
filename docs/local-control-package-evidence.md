# Node package extraction evidence — 2026-09-23

Scope: LC-28, Mako Control only. Sessions/search code was not changed by this
extraction. This records local validation, not registry publication or installed
Aside acceptance.

## What changed

The actual session engine, browser/native adapters, CLI, capture and recording
moved from `electron/` to `packages/control-runtime/src`. Desktop, extension and
managed MCP callers use declared package exports. `runtime/control` is now a
private deployment recipe depending on both Node packages. It has no duplicate
runtime implementation. Native Cua remains a separate reviewed executable.

The runtime root offers explicit standalone ownership. Empty browser configuration
does not discover the user's desktop; preview credentials are not inherited.
Program artifact output requires an absolute path. Workers and shell identity
resolve inside installed packages. Code identity hashes every compiled runtime
and core module in stable order, including the workers, CLI and launcher. Matching
relocated installs pass; changing installed engine code produces a refusal before
dispatch. No compatibility wrapper preserves the removed `electron/` entrypoints.

Several failures found during verification were fixed:

- Strict consumer compilation exposed invalid inferred observation declarations.
  Named observation/expectation results preserve optional fields without weakening
  runtime validation or using `skipLibCheck`.
- A native connection finishing after owner shutdown could escape cleanup. Close
  now waits for startup cleanup and disposes the late connection before dispatch.
- A manifests-only Docker dependency install omitted CLI executable links. The
  build now installs complete prepared packages and checks both executables.
- Desktop development now supplies its reviewed media directory explicitly. Node
  consumers use configured tools or PATH; packaged apps still require their own
  reviewed binaries and refuse a missing encoder.
- Compiler-output pruning covers removed JS, declarations and maps. The development
  watcher follows package references; moved engine changes trigger recompilation.

## Direct checks

`npm run test:control-packages` passed on macOS ARM64, Node 24.19.0. It includes:

- Real npm archives installed offline into a fresh directory outside the repo,
  with no workspace symlinks. CLI executable links work. The script also supports
  fresh caches through the public registry with an empty user config; `--offline`
  repeats the cached-install check.
- Public TypeScript imports with strict declaration checking. Private deep imports
  are refused by package exports. Runtime imports stay within declared dependencies.
- Separate CLI processes sharing program state and exact browser targets. Invalid
  input dispatches nothing; ordinary errors retain state. Text reads take no image.
- Explicit screenshot files, pinned CDP help, and a 50,000-character result spilled
  losslessly to the caller's artifact directory and read back independently.
- Build identity across relocation; changed engine code refused; restored code
  reconnects. Idempotent close and late native connection cleanup.
- Release hashes, worker inclusion and rejection of symlinks, credential canaries,
  overwrite and private registries. Explicit and packaged media lookup.

The core package suite, MCP/native adapter suite, shared browser service ownership,
browser preference, extension bridge/router/lifecycle, native capture and browser/
native recording regressions passed. Desktop and extension builds plus full
TypeScript checking passed. Full lint passed with zero errors; anti-slop reported
zero warnings/errors. Five existing renderer React/TanStack warnings remain.

One preference test still expected old error wording. It now asserts the actual
`disconnected` / `not-dispatched` fault contract. Initial consumer/media test errors
also included incorrect fixture expectations and macOS `/var` canonicalization;
those test mistakes were corrected, not reported as product defects.

## Real Linux jobs

ARM64 containers ran as uid 1000, with `--network none` and no privileged mode,
using public package resolution. The browser image was built fresh from the
prepared deployment and exact npm lock. Its executable CLI links were checked.
Native/lifecycle runs used the same new Node packages over the existing
`mako-control-runtime:21-paced` fixture image and its reviewed Cua mako.17 binary.
This does not validate later concurrent native-driver edits.

| Job | Independent result |
| --- | --- |
| Chromium form with duplicate names/Save buttons | Ambiguous unscoped input refused; documented scoped edit saved exactly once; other form unchanged |
| Browser media | Scoped PNG 65×37; finished video 780×494, 0.800 seconds; no viewport substitution |
| GTK native job | Exact Unicode text and single save; PNG 640×420, resized 320×210, JPEG; video 640×420, 0.734 seconds |
| Separate native CLI programs | Four serialized state increments returned 1–4 without state loss |
| Supervisor lifecycle | All 11 scenarios passed: isolated jobs, shutdown, crashes, lost parent, cancellation, recording finalization and stale handles |
| Cleanup | CLI jobs reported `clean:true`, worker exit 0 and runtime directory removed |

These are real software/transport jobs, not physical Mac keyboard participation,
Wayland coverage, installed Aside proof or native x64 execution of this revision.
The contributor x64 workflow now builds and tests the new package layout and runs
its packed-consumer check without cloud secrets or a privileged runner.

## Size and performance

`npm pack --ignore-scripts`, including declarations, README and LICENSE:

| Package | Compressed bytes | Unpacked bytes | Files |
| --- | ---: | ---: | ---: |
| `@mako/control` | 59,348 | 238,655 | 51 |
| `@mako/control-runtime` | 125,384 | 526,506 | 99 |

These archives exclude dependencies, native executables and encoders. The pure
core previously packed to 65,027 bytes / 73 files; removing declaration maps while
adding README/LICENSE reduced that footprint. The desktop packaging filters also
omit package declarations, which the app does not execute.

The fresh Linux browser image measured about 520.2 MB (Docker image size); npm
modules occupied about 48,844 KiB and Chromium about 357,424 KiB on that image's
filesystem. Those are different accounting methods and must not be added together.
The prepared JS/declaration/documentation payload was 154 files, about 844 KB,
without a native driver. Native/mixed image totals and the new desktop archive
still need separate measurements under LC-26.

CLI fixture commands were roughly 0.1–0.2 seconds for ordinary reads/actions;
recording/finalization and concurrent runs varied. Builds and containers were
running concurrently, so these are observations, not an A/B performance claim.
No accuracy policy, read-back check, ownership boundary or uncertainty guard was
relaxed for speed. Formal cold-start/p50/p95 comparison remains in LC-27.

Reproduce with `npm run test:control-packages`, `npm run test:control-cli`,
`npm run test:control-recording`, and the Linux recipe and acceptance scripts linked
from [the runtime guide](local-control-runtime.md). Installation/publication and
platform-specific acceptance remain explicit next gates in [Wayfinder](local-control-map.md).
