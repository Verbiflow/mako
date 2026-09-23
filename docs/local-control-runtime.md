# Local Control on desktop and cloud

Local Control does not require Electron. The native x64 acceptance run on EC2
used a Node MCP process, the native driver and a private Linux desktop. Its
runtime dependency manifest contains no Electron or provider runtime. Browser
control is also a Node service; Electron is an adapter for controlling Mako’s
own hidden windows, not a dependency of the browser service.

The full Mako application host currently still runs in Electron, including
`electron/start.mjs --web`. That flag removes its visible desktop window; it
does not turn the entire workspace/provider host into a standalone Node app.
The Local Control files living under `electron/` does not mean they import the
Electron runtime. Do not package the whole Mako app merely to run these files.

## Current boundaries

| Component | Owner and dependencies | Evidence / remaining work |
| --- | --- | --- |
| Public API and program worker | `packages/control`; Node and Zod | Shared across providers; no Electron import. |
| Shared session and MCP adapter | `packages/control-runtime/src/control-session.ts` owns native policy/state; `packages/control-runtime/src/computer-tools-main.ts` owns MCP; Node and MCP SDK | Executed on native Intel EC2 without Electron. |
| Browser transport, targets and recording | `packages/control-runtime/src/browser-service.ts`; Node, ws, image decoding and FFmpeg when recording | Can be composed directly with the MCP adapter using `browserCall`; this turn’s dev capture used that composition under Node. |
| Native driver | Patched Cua executable | Separate process. macOS uses the desktop host’s responsibility/permission chain; Linux uses the job’s display and accessibility bus. |
| Hidden Mako desk | Electron `BrowserWindow` adapter | Only needed to inspect Mako itself. Dev screenshot and recording pass after renderer readiness. |
| Cloud launcher and release | `cloud-control-main.ts` supervises a job worker and its process group; target-specific package graph | Eleven lifecycle scenarios passed on ARM64 and native Intel x64. Locally prepared, not published. |

The screenshot test initially captured an empty page during renderer startup.
A valid PNG or successful transport call does not establish application readiness.
The passing capture waited for accessible UI and was visually inspected. A
hidden desk is another client of that host, not an exact clone of the user’s
current browser tab or unsent draft.

## Cloud composition

A trusted job runner should start one control runtime inside each disposable VM
or container boundary. Agents use the same three MCP tools and bound handles.
They do not manage displays, driver processes or credentials themselves.

```mermaid
flowchart LR
  A[Agent / MCP client] --> C[Node Local Control service]
  C --> B[Browser service]
  C --> N[Native driver]
  B --> P[Job-owned Chromium]
  N --> D[Job desktop: compositor + accessibility bus + apps]
  C --> R[Recordings and screenshots]
```

Browser-only jobs need Chromium, the browser service and optional recording
media tools. Native jobs additionally need an X11 or supported Wayland desktop,
D-Bus/AT-SPI, the driver and their target applications. Electron is needed only
if a target application itself uses Electron. Separate jobs must not share a
native desktop merely because their API sessions have different IDs.

Keep two browser environments explicit:

- On a person’s machine, use the installed extension and chosen regular profile.
  Do not silently switch to remote debugging or another browser.
- In a cloud job, the trusted launcher owns Chromium and a temporary profile.
  An explicit private CDP endpoint is appropriate there. It must stay within the
  job boundary and never become a publicly reachable debugging port. Extension
  consent for someone’s existing profile is a different deployment case.

Direct CDP therefore remains useful. Removing it would break owned cloud
browsers and Mako desk inspection without improving the regular-profile route.

## Lifecycle required for a cloud release

Reuse the existing service and policy implementations, with a small platform
launcher. Do not create another agent-facing API or copy browser/native logic.
The desktop app owns that launcher locally; a cloud job supervisor owns it in
the cloud. A permanent machine-wide daemon shared by unrelated tenants is not
the default.

The launcher must:

1. Create private per-job directories, sockets, display/bus and browser profile.
   Accept only the capabilities and credentials provided by the trusted runner.
   Do not copy a developer’s home, sessions, browser profile or cloud CLI files.
2. Start only requested backends and wait for actual readiness. Keep the native
   daemon, browser connection and observation caches alive across calls, rather
   than restarting them for every screenshot or keystroke.
3. On EOF, cancellation or a deadline, stop admitting actions, cancel waits,
   release held input and begin bounded recording finalization. Close owned
   pages/processes and remove only this job’s resources. The VM/container TTL is
   the backstop if the service crashes before its cleanup finishes.
4. On a driver/browser crash, preserve interruption evidence and partial media.
   A new backend generation invalidates old handles. Reconnection never replays
   input whose result is uncertain.
5. Leave result files for the runner to collect, then remove the sandbox. Limit
   artifact duration, dimensions and storage; do not stream unrequested images.

Eleven standalone lifecycle scenarios passed on ARM64 and native Intel x64, including browser/native-only startup, concurrent isolated jobs, EOF/SIGTERM/deadline cleanup, backend and supervisor crashes, cancellation during held input, recording finalization and stale-handle refusal. See the [exact tested package evidence](audits/2026-09-23/local-control-standalone20/README.md); these runs preceded the capture21 changes. The contributor workflow reruns the same launcher acceptance. This is a locally prepared release, not a published package.

## Build and run the standalone package

The engine is the reusable `@mako/control-runtime` Node package; see
[its public imports and CLI examples](../packages/control-runtime/README.md).
`runtime/control` only assembles deployment dependencies. It has no second engine.
Run `npm run build:control-runtime`, then prepare the target's reviewed inputs:

```sh
node scripts/package-control-runtime.mjs --platform=linux-x64 \
  --driver=release/control-driver/0.28.2+mako.17/linux-x64 \
  --output=release/cloud-control-linux-x64
docker build -f runtime/control/Dockerfile --target mixed \
  -t mako-control:local release/cloud-control-linux-x64
```

Choose the `browser`, `native` or `mixed` image target; `acceptance` additionally
installs test-only GTK/Python fixtures. Browser-only packages can omit `--driver`.
Each prepared directory has an exact file/hash manifest. Node 24, FFmpeg/FFprobe
and the selected backend executables are runtime dependencies; Electron is absent.

A trusted configuration names a fresh absolute output path and explicit backends:

```json
{
  "output": "/results/job-001",
  "browser": { "executable": "/usr/bin/chromium" },
  "native": { "driver": "/opt/mako-control/native/cua-driver" },
  "timeoutMs": 3600000,
  "startupMs": 30000,
  "shutdownMs": 30000
}
```

Launch `./node_modules/.bin/mako-control-mcp --config /absolute/job.json`
inside the disposable job boundary and connect MCP over stdio. Omit unused
backends. Browser sandboxing defaults on; `sandbox:false` is an explicit trusted
runner choice, used only inside the isolated acceptance container. Do not forward
cloud credentials, the host display or a person's browser profile into the job.

The launcher creates an owner-only runtime directory. It clears inherited provider
credentials, starts only requested backends, waits for readiness and preserves
artifacts outside the runtime directory. `ready.json`, `worker.json` and
`launcher.json` report readiness, interruption and cleanup. EOF/SIGTERM/interrupt
start bounded finalization; hard failure kills the job's process group. A worker
observes parent IPC loss too, so a killed launcher does not strand its children.
A VM/container lifetime is still the boundary for untrusted agent code and a final
cleanup backstop. This runtime does not claim to sandbox arbitrary JavaScript.

For an owned headless browser that must paint continuously, open an explicit
background window with `control.openTab({disposition:'window',background:true})`.
Chrome 153 on the test Mac streamed that window but produced no frames for an
inactive tab. Recording now waits for its first real frame and refuses if none
arrives; it never activates or moves an existing tab to make recording work.
Regular-profile extension behavior needs separate installed acceptance.

The shell interface is implemented through the [shared session and CLI](local-control-cli.md).
`mako-control` provides the shell verbs; `mako-control-mcp` provides MCP stdio.
Both reuse this session engine and capture implementation.

## Reference comparison

The supplied `codex-cu-reference-evidence.md` reports a local native service and
a Linux wrapper that reuses a child process, closes it on parent exit and starts
a fresh one after a restart response. That supports the service architecture;
it does not establish OpenAI’s exact cloud isolation or explain the authors’
intent. Their Linux executable remains unavailable for direct comparison.

See [disposable-machine acceptance](local-control-ci.md) for contributor CI and
[packaging](local-control-packaging.md) for target-specific artifact status.

Latest capture package acceptance (2026-09-23): `release/cloud-runtime21-paced-arm64`
and `release/cloud-runtime21-paced-x64` pass all eleven lifecycle scenarios, including
whole-process-group cleanup. Both use +mako.17; browser recording defaults to 60 fps.
The packages contain 67 allowlisted files: 48,325,239 bytes on ARM64 and 51,645,064
bytes on x64, before npm runtime dependencies and the container's system packages.
See [capture and lifecycle evidence](audits/2026-09-23/local-control-capture21/README.md).
