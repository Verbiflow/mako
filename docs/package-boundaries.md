# Mako Control package boundaries

Accepted 2026-09-23: reusable Node packages plus composable CLIs. Session search
is out of scope at the user's request. Progress belongs to
[LC-28](local-control-map.md#lc-28--reusable-packages-and-public-entrypoints).

## Ownership

| Owner | Responsibility | Consumers |
| --- | --- | --- |
| `@mako/control` (`packages/control`) | Typed handles, observation selection, route contracts, program worker and lossless artifact spill | Runtime and custom transport adapters; no Electron/MCP/media dependency |
| `@mako/control-runtime` (`packages/control-runtime`) | Session state, target ownership, driver connection, browser service, screenshots, recordings, CLI and MCP adapters | External Node projects, Mako desktop and Linux jobs |
| `electron/` | Permission-owning application, preview UI bridge, Settings, browser installation and managed-provider wiring | Mako desktop |
| `runtime/control` | Locked standalone deployment manifest and Docker targets | Browser-only, native-only and mixed Linux jobs |
| `scripts/` | Build, packaging, fault injection and acceptance tools | Contributors and CI; not a runtime import requirement |
| Reviewed native/media executables | OS accessibility/input, capture and encoding | Explicit target dependencies; not embedded in the Node archives |

One session engine owns the state for both MCP and CLI. Separate CLI invocations
borrow it through a private socket; they do not create a replacement browser
connection or lose the task's handles. The Linux supervisor owns its children;
using the Node library with an external browser leaves that browser process with
its caller. Native Cua remains the reviewed platform implementation.

The root library factory requires an absolute artifact directory and uses an empty
browser list by default. It does not scan local profiles or inherit Mako's preview
endpoint. Desktop discovery and preview wiring are explicit host integrations.
Importing a package does not open a socket or start a process. Programs remain
trusted JavaScript; isolation belongs to the job boundary.

## Public imports and migration

See [runtime README](../packages/control-runtime/README.md) for the small set of
public entrypoints. No wildcard deep exports. The app and extension consume the
package exports; tests may exercise private implementation files. All former
engine sources under `electron/` were moved and callers migrated. Compiler-output
pruning removes deleted JS, declarations and maps so stale builds cannot retain
old entrypoints. The development build watcher follows package references.

The shell protocol fingerprints the engine and program-worker code using stable
module names. Matching archives installed at a different path have the same
identity; mismatched builds still refuse connection. Workers resolve relative to
their installed package, not `dist-electron` or the checkout. Native code finishing
connection after close is disposed before receiving any command.

Strict external-consumer compilation exposed invalid inferred observation return
types in the existing core. Named result types now preserve the correct optional
fields without changing runtime validation. Consumer checks do not use
`skipLibCheck`.

## Verification and costs

Run `npm run test:control-packages`. It packs both libraries, installs them from declared public dependencies
outside the repository without workspace links, compiles a TypeScript consumer,
and exercises the public runtime with separate CLI processes. It checks worker
state, correction errors without dispatch, explicit screenshots, CDP help data,
artifact spill, idempotent close and relocated code identity. The consumer script
accepts `--offline` for a populated npm cache; a fresh contributor run uses the
public registry with an empty user config. Packaging tests
reject symlinks, credential canaries and private-registry dependencies.

The package allowlists contain JavaScript, declarations, README and LICENSE. They
exclude declaration maps, build caches, source/tests, Python bytecode, browsers and
encoders. Both packages declare Node >=24 and Elastic-2.0 licensing. No registry
publication or license change is implied.

Current measurements and Linux acceptance are recorded in
[the extraction evidence](local-control-package-evidence.md). Archive
bytes exclude installed dependencies and platform tools. Do not interpret a
small JavaScript archive as a small Chromium/desktop image.

Publication, a newly installed desktop/Aside handoff, the latest native x64 job,
and the broader input/compositor gates remain separate. The package move does
not establish those results. `@mako/sessions` and session-search behavior are
unchanged by this work.
