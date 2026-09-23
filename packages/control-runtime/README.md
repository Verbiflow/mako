# @mako/control-runtime

The shared Node engine for Mako browser and computer control, with a composable
`mako-control` CLI. Requires Node 24+. Electron is not a dependency. Importing the
package opens no browser, driver, socket or session. Programs are trusted local
JavaScript; this package is not a sandbox.

## Use from Node

```js
import { createControlRuntime } from '@mako/control-runtime'
import { serveControlSession } from '@mako/control-runtime/session'

const runtime = createControlRuntime({
  artifacts: '/absolute/job/output',
  browsers: [{
    id: 'job', name: 'Job Chromium', transport: 'direct',
    endpoint: async () => 'ws://127.0.0.1:9222/devtools/browser/EXACT_ID',
  }],
})
const shell = await serveControlSession(runtime)
try {
  console.log(shell.file) // Private descriptor to pass to separate CLI processes.
  const signal = AbortSignal.timeout(10_000)
  console.log(await runtime.execute({ source: 'return await control.browsers()' }, signal))
} finally {
  await shell.close() // Stops shell access; does not close the borrowed runtime.
  await runtime.close() // Ends workers/connections and finalizes owned recordings.
}
```

Supply your own exact browser endpoint. The default browser list is empty; the
library does not scan local profiles or inherit the desktop preview connection.
Connections remain explicit through `control.connectBrowser(id)`. A native driver
may be provided as `native: {command, args, env}` and starts on first native use.
The native executable and browser are separate platform dependencies. The caller
owns their installation and permissions. Closing the runtime does not delete
artifacts or terminate an externally supplied browser.

## Shell composition

Keep the session owner running for the duration of a shell workflow.
Each command borrows the same private session, including its targets, program
state and uncertainty checks. JSON goes to stdout, diagnostics to stderr; images
and videos go to files. Use `--help` for exact verb options and exit codes.

```sh
mako-control --session-file "$SESSION_FILE" browsers
printf '%s' 'return await control.tabs("job")' | mako-control --session-file "$SESSION_FILE" exec --source-file -
mako-control --session-file "$SESSION_FILE" help
```

`mako-control session start --config /absolute/job.json` owns an isolated Linux
job. `mako-control-mcp --config /absolute/job.json` exposes that same job engine over
MCP stdio. Configuration and OS prerequisites are described in the deployment
recipe `docs/local-control-runtime.md` in the source repository. The supervisor
cleans up its process group after crashes, cancellation and lost parent IPC.

## Integration contracts

- Root: `createControlRuntime`, explicit standalone ownership and configuration.
- `/session`: private shell server/client and protocol validation.
- `/browser`: `BrowserService` for hosts sharing connections across task owners.
- `/host`: session and native-driver adapters for an existing permission-owning host.
- `/mcp`: `createComputerToolsServer` and the app-attached stdio entrypoint.
- `/contracts` and `/extension`: schemas shared with desktop and browser adapters.
- `/desktop`: explicit discovery and registration for Mako's desktop integration.

`/cli` and `/cloud` resolve executable entrypoints. Internal files have no wildcard
exports. MCP, CLI and desktop all use the same targeting, capture and cleanup code.
Changes to engine code invalidate old CLI session descriptors; reconnect using the
current owner instead of silently mixing versions.

Recording uses FFmpeg/FFprobe on PATH, or both tools in an absolute
`MAKO_CONTROL_MEDIA_ROOT`. Packaged desktop builds require the reviewed tools in
their application resources. Sharp installs only the current platform's optional
native package; this package includes no browser, driver, encoder or Python cache.

Licensed under Elastic License 2.0; see LICENSE. Publishing is a separate release
step. Current physical-input, compositor and installed-browser acceptance limits
remain in `docs/local-control-map.md`; package extraction does not establish parity.
