# Mako audio pilot: source findings and recommendation

Investigation date: 2026-09-07 America/Los_Angeles. Read-only against `/Users/kashyab/pi-ui`; clones, dependency installation, builds, measurements and probes are confined to `/tmp/mako-ui-pilot-audio/run-QaGb8b0U/`. No sound was played. FFmpeg decoded samples into memory for numerical measurement only. No Mako source was edited and no provider prompt was sent.

## Decision

Build ONE Mako-owned Web Audio engine supporting synthesis recipes and sampled assets. Selectively adapt Cuelume recipes with its MIT notice; select a few provenance-verified Kenney samples from Soundcn's original OGG assets with an asset manifest. Give both exactly the same context, master gain, priority policy, voice tracking, mute, preview and disposal lifecycle.

**The direct Cuelume API does not accept an existing AudioContext or destination.** It privately owns its context/output. Its package exports only play, bind, setEnabled, setVolume, sounds and SoundName. Recipes are not a public package export. Installing Cuelume alongside Soundcn's engine would create separate engines. Selected recipe vendoring requires a Mako renderer for those recipes, or an upstream context-injection change; it is not achieved by wrapping the current play function.

| Approach | Assessment |
| --- | --- |
| Direct `cuelume@0.2.2` | Good small isolated interaction experiment. ESM, no runtime dependencies, thoughtful recipes and tests. Reject as the coordinated production engine: no injected context/destination, stop, active master mute, voice handles or dispose/unbind. |
| Soundcn registry installation | Copies source/assets; root package is a private Next.js site, not the installable audio SDK. Reject stock hook/engine for application-wide ownership. Source and committed install JSON drift. |
| Vendor both engines | Retains two lifecycles, volume systems and caches. Reject. |
| Selected recipes + selected samples + one custom engine | Recommended. Reuse sound design, own the small lifecycle/policy layer that Mako actually needs. Do not import the full catalog or website/Jotai settings. |

## Evidence pins

- Cuelume: `b879b72c01f3b3fa74c45c9b20bbd064baffb282`, clone `cuelume/` beneath this report. [Pinned source](https://github.com/Danilaa1/cuelume/tree/b879b72c01f3b3fa74c45c9b20bbd064baffb282).
- Soundcn: `7cbfbb3f56e8548b81fb26410bdcea657447d087`, clone `soundcn/` beneath this report. [Pinned source](https://github.com/kapishdima/soundcn/tree/7cbfbb3f56e8548b81fb26410bdcea657447d087).
- Mako HEAD: `a5bde7b76cdc0eb30fa1abf42eacb15456ab73f1`. Inspected the current working tree, which already contains substantial uncommitted changes, including session/main files. HEAD alone does not reproduce those local findings.
- npm registry query reported Cuelume 0.2.2, unpacked size 47,845 bytes, integrity `sha512-TiNzJRjhddjC4jy4M7sv63V/86VaFhdIs6iHUCrc4CKhqypaxRBv1aedCBGebrz/cO7nroPkEfqHe/P7fOE2GQ==`. Unit tests used the pinned clone, not the published tarball.

## Cuelume: exact source and behavior

Paths below are relative to the pinned Cuelume root.

- `src/index.ts`: public exports; imperative `play(name?, {volume?})` returns void; `bind(root?)` returns void. There is no React hook, context injection or public recipe API.
- `src/sounds/recipes.ts`: 17 synthesis recipes. Tone/noise layers, envelopes, optional pitch glides and feedback-delay shimmer. Noise is generated with Math.random at context sample rate; no downloaded or embedded audio files. Selected useful candidates are press/release/toggle, loading, success, error and ready. Names and comments are design intent, not a listening assessment.
- `src/audio/engine.ts`: lazy singleton context, output gain 4 into a compressor with threshold -8 dB and ratio 12. Per-cue gain and optional shimmer. Sources receive scheduled stops; master/shimmer nodes disconnect on a timer after the computed tail. This is cleanup, but it is not application disposal or an explicit hard clipping guarantee.
- User activation is checked before context creation when `navigator.userActivation` exists. A suspended context is resumed; rejected resumes are swallowed. There is no expiration for pending cues. Resume completion rechecks enabled/state but uses the volume captured before resume.
- `setEnabled(false)` and `setVolume(0)` affect future requests, not active graphs. A pending play can still use the old volume after volume changes. The silent probe reproduced a pending chime master gain of 0.5 after setting global volume to zero.
- Context and output are retained indefinitely; a closed context is not recreated. No stop-all/dispose, no timer cancellation, no global voice cap or event dedup.
- `src/interactions/bind.ts`: delegated capture listeners; WeakSet idempotence per root and event, dynamic DOM support, fine-pointer hover throttled globally at 150 ms. No unbind; module replacement can establish another set of listeners. Press/release are pointer events, toggle is click and supports native keyboard activation. These are not successful-domain-action events.
- `package.json`, `LICENSE`: ESM-only, zero runtime dependencies, MIT, copyright Daniel Belyi. Retain the notice for adapted source.
- `test/runtime.test.mjs`: six tests cover palette, activation, invalid/blocked audio, volume/output reuse, binding and shimmer cleanup. All six passed using `npm ci --ignore-scripts --no-audit --no-fund` and `npm test` inside the clone.

Measured emitted JS for index/engine/recipes/bind concatenated: 19,580 bytes, gzip 5,217 bytes. This includes emitted comments and is not a production bundler size. Synthesized audio payload is zero bytes. Source stop times span 69–625 ms including the source padding; complete cleanup spans 119–1,795 ms. Success cleans up at 1,004 ms, arrival at 1,795 ms, so the tail can outlive a nominal short interaction. No quality tiers exist; recipe envelopes, timbre, gains and device sample rate determine output.

## Soundcn: exact source and behavior

Paths below are relative to the pinned Soundcn root.

- `registry/soundcn/lib/sound-engine.ts`: lazy context, Map keyed by complete data URI, base64 decode and AudioBuffer cache. `playSound(dataUri, {volume, playbackRate, onEnd})` returns a Promise of a stop handle. It awaits resume and decode but cannot be canceled while those are pending. No master gain, voice pool, cache bound, in-flight decode sharing, dispose or context recovery. End callbacks do not explicitly disconnect nodes.
- `registry/soundcn/hooks/use-sound.ts`: returns `[play, {stop, pause, isPlaying, duration, sound}]`. Options include volume, playbackRate, interrupt=false, soundEnabled=true and stopOnUnmount=true. Decodes in an effect even when disabled, creating a context on mount. Play before decoding completes is dropped. Resume is neither awaited nor caught. Only the latest source/gain is tracked. With interrupt=false, older voices survive stop/unmount; an earlier end callback can incorrectly clear isPlaying. Pause calls stop and does not retain an offset. Changing sound leaves the old buffer available until the new decode finishes. Decode rejection has no catch.
- `public/r/use-sound.json` and sample-bundled type JSON lag the source: committed install payload lacks stopOnUnmount. The standalone hook JSON has no declared registry dependency for its imported engine/types. `public/r/click-soft.json` embeds the sample, types and engine but not the hook. Inspect exact install contents instead of relying on README shorthand.
- Website `lib/sound-engine.ts` adds Jotai settings to imperative playback, while `hooks/use-sound.ts` constructs gains itself. `hooks/use-audio-settings.ts` defaults to unmuted/full volume and persists to its own storage key. These website settings are not in the registry engine and should not be copied into Mako.
- `scripts/encode-all.ts` and `scripts/encode-sound.ts`: fixed libmp3lame 64 kbps, mono, 44.1 kHz. No bitrate/quality option. `hooks/use-sound-download.ts` downloads the existing embedded bytes; it does not retrieve a higher-quality original.

### Actual inventory and quality evidence

The pinned source contains **813 sample modules, 805 unique binary payloads**, and 806 original OGG files. All 813 module metadata entries say Kenney/CC0. The registry manifest contains 816 items including support modules; committed public/r contains 817 JSON files, of which 813 carry sound metadata. Do not substitute the README's “700+” for a measured payload count.

| Measurement | Binary MP3 bytes | Base64 characters/bytes | Whole TS module bytes |
| --- | ---: | ---: | ---: |
| Total | 6,943,190 | 9,258,784 | 9,460,774 |
| Median | 5,685 | 7,580 | 7,822 |
| 95th percentile | 38,286 | 51,048 | 51,281 |
| Range | 669–72,349 | 892–96,468 | 1,123–96,725 |

Catalog metadata durations range 7 ms–8.966 s, median 635 ms. These are not all brief UI ticks. Base64 adds about 33% before compression and embeds media in JS; decoded PCM also consumes memory. Prefer a tiny asset allowlist and byte-bounded cache.

| Candidate | MP3 bytes | TS bytes | FFmpeg decoded duration | Float PCM peak |
| --- | ---: | ---: | ---: | ---: |
| click-soft | 669 | 1,127 | 7.12 ms | -1.79 dBFS |
| click-001 | 1,296 | 1,961 | 97.12 ms | -1.86 dBFS |
| confirmation-001 | 2,968 | 4,207 | 289.84 ms | -1.43 dBFS |
| error-001 | 1,923 | 2,797 | 161.66 ms | +0.98 dBFS |
| switch-001 | 5,476 | 7,539 | 614.76 ms | +1.32 dBFS |

All five decoded probes confirm 64 kbps mono at 44.1 kHz. Positive float peaks indicate overshoot and clipping risk at unity output; these are not true-peak/LUFS measurements or proof of a specific browser's decode behavior. No perceptual audition was performed. RMS varies materially across these samples; do not assume equal gain means equal perceived loudness.

Original alternatives under `assets/kenney_interface-sounds/`: click_001.ogg 4,876 bytes; confirmation_001.ogg 8,968 bytes; error_001.ogg 7,373 bytes; switch_001.ogg 6,753 bytes. All are 44.1 kHz; the latter two are stereo, which the MP3 conversion removes. These originals avoid another lossy transcode, but OGG Vorbis itself is not lossless. For this Electron pilot, compare these local originals against the compact MP3s only through user-initiated previews. Raising the MP3 bitrate after the fact cannot restore lost information.

### Licensing distinction

`LICENSE` is MIT for code, copyright KapishDima. `README.md` and `lib/legal.tsx` explicitly warn that a Warcraft collection is Blizzard property and not freely licensed. This pinned checkout has no Warcraft sample payloads; the warning and `scripts/fetch-wowhead.ts` remain. Do not claim Warcraft is present in the measured 813 modules, or that MIT covers every asset the project might offer.

`assets/kenney_interface-sounds/License.txt` explicitly permits personal, educational and commercial use under CC0; attribution is optional. [Kenney's original pack page](https://kenney.nl/assets/interface-sounds) independently identifies CC0. Use that verified pack, retain provenance/hashes and the license copy. The batch encoder hardcodes Kenney/CC0, so generated metadata alone is not provenance evidence for future additions. The asset type's license union cannot represent the README's non-free exception.

## Mako architecture and integration points

All paths here are relative to `/Users/kashyab/pi-ui` and refer to the inspected working tree.

- `src/state/prefs.ts`: Prefs/defaults/parsePrefs/setPref, localStorage key mako.prefs.v1 with legacy migration, microtask-batched persistence. No audio preference today. Add validated audio settings here; do not add a second storage owner. Include migration/default tests, finite clamped gain and a discriminated mode such as off/attention/full. Web and desktop origins need not share this localStorage.
- `src/components/settings/settings-dialog.tsx` and `src/components/settings/sections/manifest.ts`: searchable section descriptors. Add a Sound section under Desk with keywords, explicit preview controls and clear playback status. Follow existing typography/tokens and pressable controls.
- `src/App.tsx`, `src/components/ui/sonner.tsx`: one Sonner display. Toasts originate in many state actions and components. No existing application Web Audio or native Notification constructor was found. Do not attach sound to the Toaster, generic errors, rendered toast count, or transcript mount.
- `src/state/session.ts`: apply routes host events; absorb handles background tabs and unread completion marks; applyToActive handles notices, thread-run and automation-run. Normalize semantic feedback at event ingestion before active/background presentation splits. Token stream/messages/tree updates must stay silent.
- `src/state/live-recovery.ts`: revision guard, snapshot hydration and gap recovery. Derive feedback only from accepted fresh lifecycle transitions; hydration and replay seed state silently. Observe all live conversations, including ones without a bound native thread path.
- `src/state/acp-live.ts`: syncThreadStatus handles running, permission, failed, ready and queued work, but returns immediately without threadPath. It is useful existing status logic, not a complete notification owner. Generic running-to-ready can also include cancellation; explicit request outcome is safer for sound.
- `src/state/thread-status.ts`: applyThreadRun sets working/review/failure and emits failure toasts. `src/state/threads.ts:applyThreadActivity` suppresses identical external snapshots. External active disappearing can mean stale/unavailable/closed, not successful completion; never play success from that inference.
- `electron/contracts/live-conversations.ts`: LiveRequest.id/status/nativeRun, LiveBatch.revision and permissions. `electron/contracts/providers-acp.ts`: LiveSessionState.nativeRunId and LivePermissionRequest.id. `electron/contracts/automations-usage-updates.ts`: AutomationRun.runId. Use these identities for dedup.
- `electron/contracts/conversation-session.ts`: ThreadRunState has path/harness/status/error but **no run ID**. Robust reconnect/restart dedup requires a stable host-issued run/event identity here; renderer cooldown alone cannot provide it. Keep any new identity provider-neutral and carried through electron/shared.ts.
- `src/state/git.ts`: commit/push promises are useful successful-outcome ownership points. A click is not success. Keep push a separate deliberate action. Same principle applies to prompt acceptance and draft safety in session/composer: never claim acceptance from the minutes-long completion promise.
- `src/components/shell/app-shell.tsx`: boot/dispose pattern and settings lifecycle. `src/main.tsx` uses React StrictMode. Bind audio once through a state/domain lifecycle with an explicit disposer; preview components call domain actions and read narrow selectors. Components never import the bridge.
- `src/desk/use-desk-commands.ts`: register mute/stop-preview commands here using the command registry, not bare keyboard listeners.

## Coordinated audio design

Default off. Offer an opt-in attention mode and a fuller tactile mode. Preview is explicitly user-triggered and must not silently enable event sounds. Provide master volume, event-category switches, foreground/background policy, per-event sound/None selection, Reset and Stop preview. A separate clearly labeled preview action may audition a candidate while event sounds are off, using the selected preview/master gain. Master mute and Stop terminate all active sound. Selection, slider changes, opening settings and application launch are silent.

Use one related family: short dry synthesized acknowledgements for accepted actions and reversible controls; related rising/falling motifs for completion/refusal; a restrained sampled texture for attention requests if audition proves it improves distinction. Match timbre and loudness before adding variety. Suggested envelope targets: 20–70 ms tactile feedback, 100–350 ms outcomes, at most 500 ms attention with a bounded tail. These are pilot design targets, not current measured Cuelume durations.

Event ownership:

| Semantic event | Owner and rule |
| --- | --- |
| Prompt accepted | State preflight/dispatch acceptance, once per request. Never one sound for every queue/stream update. |
| Permission or question needs response | Accepted lifecycle transition, keyed by request ID. No repeat while pending. |
| Run completed | Final successful request/run outcome, after queue policy. Skip canceled/interrupted/uncertain runs. Background completion useful; foreground optional. |
| Run failed | Same canonical run owner; one failure sound even if notice, toast and attention marker all appear. |
| Commit or push succeeded | Successful domain action, distinct action IDs and no sound on failed promise. |
| Toggle/copy/navigation | Optional tactile mode, one successful action acknowledgement. Avoid global pointer binding. |
| Tokens/tools/catalog scans/hover/boot/reconnect | Silent. External stale activity must never masquerade as completion. |
| Preview | Separate preview owner; latest preview replaces previous; closing settings cancels it without canceling unrelated event state. |

Dedup is semantic first, acoustic second. Canonicalize live ID/native path aliases through existing bindings, then key events by conversation + run/request ID + outcome. One operation supplies toast, visual attention and sound. Do not key on message text, component identity, provider name alone or current selected tab. Consume suppressed events so unmute/focus changes do not replay them. Keep bounded event IDs/cursors; snapshots establish a silent baseline after restart. IDs must exist at the host boundary for cross-transport/restart correctness.

For bursts, proposed policy: two audible voices maximum, one preview voice, at most one routine cue per 250 ms; attention/failure preempts lower-priority tactile feedback, and aggregate simultaneous completions rather than queueing a chime storm. Expire unfired feedback after about one second; never flush accumulated cues after an unlock. Tune these values through explicit audition. A bounded debug log should explain suppression without storing prompt text.

## Autoplay, Electron and cleanup

Mako's `electron/main.ts` enables backgroundThrottling and does not set autoplayPolicy. Both its installed Electron declaration and [Electron documentation](https://www.electronjs.org/docs/latest/api/structures/web-preferences) specify no-user-gesture-required as the default. Thus browser autoplay blocking is not an opt-in mechanism for desktop. Cuelume separately checks userActivation; Soundcn does not. Enforce Mako's own user preference and gesture-gated initialization rather than relying on either library's behavior.

A single owner creates the context lazily. Coalesce resume/decode promises; return typed played/suppressed/blocked/failed outcomes. Recheck mute, event age, generation and owner after every await. A generation token invalidates pending work after stop/dispose/restart. Track all source nodes; use gain ramps for stop/mute, disconnect ended graphs, close contexts on disposal, clear cache/timers/listeners, and recover closed/interrupted contexts without resurrecting expired cues. The master gain must actually control currently playing voices.

On HMR, StrictMode teardown and pagehide, dispose explicitly and idempotently. Background throttling means JS cleanup timers are not precise; schedule source stop and gain envelopes on audio time. Hide should cancel previews; attention playback while hidden follows preferences. Host reconnection and renderer recovery must hydrate silently. `electron/main.ts` reloads a failed renderer and on macOS keeps the app alive when the last window closes. A destroyed renderer cannot deliver audio. If closed-window notifications are required, add a host-owned notification adapter with an explicit single delivery owner. Never create a second renderer audio engine or let OS notification audio and a custom cue both fire for the same event. Multiple web clients likewise require a designated delivery owner/host arbitration, not independent local caches pretending to guarantee once-only playback.

## Verification performed and acceptance gates

Performed:

1. Cloned both repositories into unique /tmp paths and pinned HEADs.
2. Cuelume `npm ci --ignore-scripts --no-audit --no-fund` then `npm test`: **6 passed, 0 failed**. `cuelume-tests.txt` records the final run. An initial attempt using Mako's TypeScript 6 failed on Cuelume's rootDir configuration; using the project's locked compiler resolved that environment mismatch without changing source.
3. `python3 measure.py`: counted/hashed all 813 sample payloads; measured exact binary/base64/module bytes and five decoded samples with ffprobe/FFmpeg. `measurements.json` and `asset-inventory.json` preserve results.
4. `node probe.cjs`: source-execution probes with fake Web Audio, no device access. Confirmed two concurrent decodes for one URI, one older voice surviving a two-play unmount, closed context reuse, and Cuelume stale volume after resume. `probe-results.json` records results. These are targeted contract reproductions, not real-browser performance tests.
5. Inspected source, committed registry JSON, original asset licenses and Mako's current state/host contracts. No Mako source change, so Mako lint/build/UI execution was not needed for this read-only investigation. No claim of listening quality or end-to-end audio validation.

Acceptance gates for implementation:

- Fresh web profile and fresh Electron launch with sound off: zero source starts, no resume/decode/context creation on settings mount. Enabling alone is silent. Explicit preview produces one cue; selection/volume edits do not.
- Exercise actual engine graph via OfflineAudioContext without connecting to hardware. Verify envelope lengths, finite sample values, headroom at maximum permitted overlap and sample/synthesis master gain parity. Follow with user-initiated listening on speakers/headphones; numerical peaks do not prove pleasantness or intelligibility.
- Replay one completion through live batch, notice, native thread event, tab switch and snapshot: exactly one audible decision. Hydration/restart: zero historical cues. A new run on the same path must still sound once. Verify permission request identity and aliases, canceled runs, queued work and unbound live sessions.
- Feed 100 rapid mixed events: bounded voices/cache/log, no cue backlog, failure/attention precedence. No transcript/rail rerenders caused by token-driven audio subscriptions.
- Resolve slow decode/resume after mute, preview replacement, dialog close, context disposal or HMR: zero late starts. Concurrent requests for one sample decode once; old source endings cannot clear a newer preview's status.
- Repeated mount/unmount, renderer reload, sleep/wake, host reconnect and macOS last-window close/reopen: no surviving nodes/listeners, no ghost cues, no unhandled rejection, new eligible playback works after recovery. Test real `npm run dev` URL without mock and real desktop, using explicit preview only unless event playback is deliberately enabled.
- Test multiple clients and OS notification fallback: one audible delivery per canonical event, including owner loss/reassignment. Show the closed-window capability limit if no host notification adapter is implemented.
- Validate old/corrupt/out-of-range stored prefs, origin differences and disabled localStorage. Keyboard and screen-reader users can operate Play/Stop; sound conveys no information unavailable visually.
- Packaging offline: only selected licensed assets, provenance and hashes; no runtime catalog fetch; bounded decoded cache. Run `npm run lint`, `npm run lint:anti-slop` with zero warnings/errors, and host-input generation/test:web if handler arguments change.

Rerun from this folder: `python3 measure.py`, `node probe.cjs`, and `npm test --prefix cuelume`. The probe uses TypeScript from the isolated Cuelume installation. No implementation has been added to Mako.
