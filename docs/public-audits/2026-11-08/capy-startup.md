# Capy desktop startup and what Mako can use

Measured 2026-11-08. Capy 0.7.2, installed locally, build
`ffebce626d04b937d731ce0c140ed4e174b99ed2`. Mako's package names revision
`06f53ffebdc3dbe297dc382e7a11b191619af305`. The renderer comparison uses this
Thread's source at `f74a33558ea46ea9c095b43d1c10eaa83cd3f23d`, with only the
viewer chunk strategy changed between builds.

The concrete change is to let Vite split the Office renderers automatically.
The viewer plugin's renderer grouping put Vite's shared preload helper into
the PowerPoint chunk. Mako's entry imported that helper, so startup loaded
PowerPoint even when no document was open. The changed build removes 336,638
bytes (22.6%) from the entry's static JavaScript dependency graph, from
1,486,628 to 1,149,990 bytes. The renderer modules remain available on demand.
The small timing differences below do not establish a startup speedup.

## Measurements and limits

These are isolated, signed-out/empty-profile probes, not comparisons of
populated accounts or agent response speed. No agent prompt was sent.
Each app ran alone during its measurements on a Mac15,10 with 14 logical
CPUs, 36 GiB RAM and macOS 26.6.2. Other people's normal processes remained
running. Load averages during the measurements were 6.88/8.63/10.01; these
are observations, not evidence of a quiet machine.

The original installed Capy remained separate. The probe used its unchanged
renderer with a private main-process copy on Electron 44.10.0, the same
Electron version as the installed app. Its user-data location was redirected,
URL-handler registration and the move-to-Applications prompt were disabled,
and its window used `showInactive`. Mako used an isolated copy of its
Electron 43.4.0 package and private home/profile. The changed Mako probe
replaced only that copy's renderer assets. Neither probe was installed.

“Cold” here means a new app profile and no profile host, with the machine's
filesystem caches already warm. It is not a disk-cold or post-reboot launch.
The Mako criterion is the preload plus composer element existing; Capy's is
its Sign in control existing. These measure different DOM states. They do
not measure successful input, signed-in sidebar hydration, cloud machine
startup or first agent output. A debugger page target is also not proof that
a native window is visible. Paint timings are separate from the criterion.

| Run | Mako before, criterion ms | Mako after, criterion ms | Capy, criterion ms |
| --- | ---: | ---: | ---: |
| Empty profile, host absent | 2,775 | 2,725 | 2,739 |
| Warm profile, first desktop reopen | 757 | 711 | 1,299 |
| Warm profile, second desktop reopen | 754 | 721 | 1,061 |
| Warm profile, host restarted too | 1,393 | 1,332 | Not comparable |

Mako's two desktop reopens reuse its host. Capy's runs restart its desktop
process tree. This is another reason not to rank the apps from this table.
There is one empty-profile sample per variant and two desktop reopens,
measured sequentially, without randomization or a confidence interval.

First contentful paint for Mako was 2,857/820/816/1,470 ms before and
2,796/789/804/1,406 ms after, in table order. Capy reported no paint entry
in the first two samples and 1,033 ms in the third. An absent paint entry
is not zero latency; covered/inactive windows limit this observation.

After five seconds of settling, the next 15 seconds used 20.6–41.0% of one
CPU core for Mako before, 20.27–50.87% after, and 8.60–8.93% for Capy.
This is early background activity, not established steady-state idle usage.
Mako also owns a local host, discovery and watchers; signed-out Capy does
different work. No CPU improvement is demonstrated by the change.

Summed per-process physical footprints were 880–1,005 MiB for Mako before,
924–1,001 MiB after and 692–693 MiB for Capy. These sums are not a
deduplicated process-tree footprint. Process snapshots sometimes included a
short-lived `ps` or `lsof`, and detached crash reporters are outside the
descendant walk. RSS is kept separately because shared mappings make it a
poor comparison of application memory. No memory reduction is claimed.

All 11 readings and the two static import closures are in
[capy-startup-readings.json](capy-startup-readings.json). Renderer task
counters were enabled after debugger attachment and sampled later, so they
are not a complete measurement of renderer CPU from spawn to readiness.

## What the installed Capy actually does

Source references below name the installed Resources folder. `main.js`
line numbers refer to its extracted asar, `out/main/main.js`; renderer files
are already outside the asar under `renderer/`. They are primary local
evidence, not claims about Capy's backend implementation.

- **A local shell with V8 caching.** Main lines 69455–69478 register a
  standard, secure custom scheme with `codeCache`. Lines 69987–69991 read
  `_shell.html` before registering its handler. Lines 71218–71236 give
  hashed assets immutable year-long cache headers and ETags; documents use
  no-cache. The asset handler still reads files before constructing those
  responses, so this is not evidence of a universal in-memory asset cache.
  Mako already registers a code-cache-enabled scheme in
  `electron/desk-scheme.ts` and serves it in `electron/desk-protocol.ts`.
  Reintroducing this as a new Mako optimization would duplicate existing work.
- **Desktop services start after the window loads.** Main lines
  69502–69503 define an idempotent service-start function; lines
  70168 and 70018 invoke it after `did-finish-load`, on load failures,
  or after a 2.5-second fallback. Its workers follow change streams for
  desktop state and import progress (69693–69741). Not everything is a
  subscription: lines 69754–69757 poll network availability every two
  seconds. This is evidence for ordering visible work first, not for
  copying all of Capy's background scheduling.
- **Windows show before all that work completes.** Main lines
  70126–70214 create a sandboxed window with a theme background, restore its
  bounds, and call `show()` before loading the page. Mako shows on
  `ready-to-show` in `electron/client-main.ts`; its `start()` awaits
  `ensureRuntime` before opening a window. Those are concrete differences,
  but showing a background sooner is not the same as making controls usable.
- **Bounded import work leaves the main thread.** Main lines
  56849 and 57013–57039 start `import-worker.js` for a session import with
  a 768 MiB old-generation limit, an empty environment, and termination on
  scope release. This is on-demand import processing, not an eagerly
  started general worker pool. The separate 460 KB `mint` bundle is a
  static import at main line 1; it must not be described as a lazy chunk.
- **Subscribe before the initial read.** Preload lines 400–415 subscribe
  to update changes, then request current state, ignoring that initial
  response if a newer change has arrived. Mako's `src/state/session.ts`
  already attaches `onEvent` before boot and guards connection generations.
  The useful invariant is present in both apps.
- **Some offscreen and deferred work exists.** The renderer assets contain
  virtualizer code, `content-visibility`, workers and visibility observers.
  This establishes shipped mechanisms, not their benefit on an authenticated
  page. The `requestIdleCallback` near offset 538079 in
  `index-rxj6zFrh.js` schedules acquisition/telemetry work; it is not evidence
  that conversation hydration waits for idle. IndexedDB uses found in the
  inspected assets handle backgrounds, uploads and notification sounds.
  I did not establish durable caching of the signed-in conversation list.

Capy ships its own `renderer/bundle-report.md`, identifying the build and
separating raw, gzip and Brotli sizes by route. It reports 5,671,140 raw JS
bytes for the signed-in app route. Following the shell's modulepreloads and
static imports independently found 68 chunks totaling about 5.41 MiB.
Its full JavaScript assets total about 32 MiB. These are build-graph sizes,
not measured signed-in network requests or parse times. The inspected Mako
entry was smaller even before this change, so this evidence does not support
the premise that Capy's speed comes from a uniquely small JavaScript bundle.

## Ranked changes for Mako

1. **Keep Office renderers lazy. Implemented in this branch.** Set the
   viewer plugin's `chunkStrategy` to `none`, allowing ordinary splitting
   of shared helpers. Both builds emit 13 startup chunks, but PowerPoint's
   330 KiB chunk leaves the static closure. The production smoke check
   verified that Word, spreadsheet and PowerPoint renderer modules are absent
   before use and initialize successfully when imported over `mako-app://`.
   It did not parse or visually validate sample Office documents.
2. **Measure the work before the first renderer, then test an early shell.**
   The baseline debugger target appears at 2,559 ms with a fresh host and
   537/550 ms when the host already runs. That interval includes process
   launch, imports and host connection; it cannot all be attributed to
   `ensureRuntime`. Instrument those stages before changing readiness.
   A follow-up can test opening a noninteractive loading shell before host
   attachment, while preserving explicit failures and command gating.
3. **Profile discovery after a window opens.** `session.boot()` invokes
   `providers.loadAll()` and runtime-update discovery immediately. The probe's
   local host logs show Cursor auth/model discovery despite an empty profile.
   The early CPU readings justify a profile with named jobs, not the claim
   that discovery caused every sampled CPU cycle. Compare deferred discovery
   against first model-menu and first-send latency before moving it.
4. **Keep a route/entry dependency budget.** Capy's bundled report makes
   accidental eager imports inspectable. Mako should retain a production
   manifest check that follows actual static imports, alongside lazy-viewer
   checks. A total asset-directory size alone would miss this regression.

Items 2–4 are recommendations, not implemented features or measured gains.
Drive, tool parity, T3 Code and model-selection labeling belong to their
separate workstreams and were not changed by this investigation.

## Reproduction and verification

`scripts/bench-desktop-startup.ts` requires an explicit free Thread port and
scratch root. It saves every result before cleanup, retains the host between
Mako desktop reopens, and clears the stopped desktop handle before the
shared package helper stops the host. The interrupted version lost all
readings when that helper attempted to signal an already-ended desktop.
Another app requires an explicitly redirected probe build; passing
`--userdata-env` to an unmodified app does not make it honor that variable.

Build production assets with `npx vite build --manifest --outDir <scratch>`.
Follow `index.html`'s `imports` recursively through `.vite/manifest.json`,
sum the emitted files, and distinguish `dynamicImports`. The before build
uses the same source and viewer options with `chunkStrategy: renderer`;
the after build uses `none`. No dependency versions were changed.

Validation includes both production builds, all 11 startup readings,
the static import comparison and a sandboxed Electron check importing the
three lazy renderer modules over Mako's scheme. The original installed
Capy remained running separately. Probe processes and the temporary preview
server were stopped; the person's app processes were left alone.

The full application/backend suites and authenticated Capy interactions
were not run. Native visual Office rendering remains unverified. The
required lint and typecheck results are reported in the handoff. The type
check first caught the earlier navigation prototype missing main's new
`idle` child-group heading; this branch supplies that heading too. It also removes obsolete radius classes, uses the current type scale and brand token, and separates shared label and hook exports from components. The roster loop retains its snapshot with `slice()` instead of an unnecessary spread; no iteration semantics changed.
