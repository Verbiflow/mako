# Harness defaults and composer settings audit

Implemented on 2026-09-08. The seven findings below describe the pre-fix behavior and preserve the audit evidence. Reference repositories remain unchanged.

The implementation puts settings schemas, provenance, option aliases, precedence, variant resolution, and provider catalog normalization in `@mako/sessions/settings` and `@mako/sessions/model-catalog`. Host modules discover configuration and translate wire requests. Renderer state resolves the same selection for controls and dispatch, scopes edits to a draft or thread, and reconciles provider acknowledgements without erasing newer edits.

New drafts follow workspace configuration unless the user saves a choice. Existing threads use their own latest reported settings. Legacy preferences remain labelled as legacy and can be reset explicitly. Missing observations stay unknown. Every queued request persists its own settings; duplicate receipt IDs reject different settings as different content.

Codex discovery reads paginated models plus workspace config, preserves runtime acknowledgements, and sends `default` for explicit Standard. Its legacy `fast` speed name canonicalizes to `priority`, avoiding duplicate Fast choices. Claude reads declared settings layers without inventing absent effort or speed, and marks launch-only controls as unavailable for live changes. Devin preserves declared default variants; Cursor preserves model parameters; OpenCode no longer substitutes a guessed model or reasoning default. Profile caches preserve option metadata and refresh per workspace and selected account.

## Main finding

Mako mixes catalog capabilities, provider configuration, saved composer preferences, historical thread metadata, and active session settings. There is no single resolved selection consumed by both the composer and the send path. Consequently the controls can describe settings different from those sent to the provider.

## Confirmed findings

1. **Codex configured defaults are never discovered.** `electron/providers/codex/profile.ts:40` calls only `model/list`. `normalizeCodexModels` in `electron/harness-models.ts:277` turns `isDefault` into the default model and `defaultReasoningEffort` into `current`. There is no `config/read`, workspace argument, or configured reasoning/speed field. A catalog default is not evidence of the effective workspace configuration. The profile loader contract accepts only an environment, so workspace-scoped defaults cannot be represented correctly by that API.

2. **Discovery becomes a permanent override.** `src/state/thread-tuning.ts:36` imports catalog `current` values into `composerTuning`, persists them, and marks the provider imported. Subsequent external changes are deliberately ignored. Even a partial existing override prevents importing other defaults. `scripts/test-tuning-import.ts` explicitly tests this freeze. Fresh discovery alone therefore cannot repair existing saved values. There is no provenance to distinguish an automatically imported value from an intentional user choice.

3. **Display and dispatch use different precedence.** `src/components/composer/foreign-model.tsx:45` prefers the historical thread model. `foreign-effort.tsx:37` uses that model's options with provider-wide saved tuning, or a historical variant's values. `src/state/acp.ts` and `src/state/thread-continuation.ts:104` dispatch provider-wide `composerTuning`. Opening thread A while the saved choice is model B can show A while sending B. `composer-routing.tsx:29` temporarily suppresses the historical label after an explicit model click, but stores that exception in component state for only one context. It is not a durable thread selection. For variant models, historical variant values also take precedence over option edits.

4. **Confirmed runtime settings are discarded.** `electron/codex-app-parse.ts:269` parses the open-thread response's model, service tier, and reasoning effort. `electron/codex-app.ts:174` uses the thread ID, cwd, and history but never publishes those resolved settings. Codex live state starts with empty config options. ACP does publish config options, but the composer option controls read provider profiles rather than those live config options.

5. **Speed is represented inconsistently.** Codex normalization accepts `serviceTiers` but ignores `additionalSpeedTiers`. A catalog containing only the latter yields no speed control. Codex's service tier is a select, so `foreign-effort.tsx:52` excludes it from the visible Fast button and places it in the options popover. The importer's speed-name heuristic converts a string tier such as `fast` into `fast: false`, while retaining `options.serviceTier: 'fast'`. App-server serialization honors the string option first; its boolean fallback sends `fast` only for true and omits false. The native Codex runner ignores the boolean entirely despite advertising fast support. Explicit standard, inherit, and unknown need distinct representations and provider-owned wire mappings.

6. **Other providers also substitute guesses for defaults.** Claude normalization sets supported Fast mode to false without reading its configured state. Devin honors the default variant only enough to identify its family; launch ID and option currents still come from the first variant. OpenCode marks `medium` as a default variant and prefers a named free model or the first model when configured discovery fails. Cursor reads its configured model, but removes bracket suffixes and deduplicates by the base ID, which can erase distinctions if those suffixes encode selectable options. These findings follow the code; they are not claims about every installed provider's current catalog.

7. **Reloading the profile cache loses default metadata.** `electron/provider-profile-cache.ts:11` validates option values with only `value` and `label`. Zod strips `default` and `description` when reading the cache. Select options that rely on `values[].default` and have no `current` behave differently after restart.

## What the reference apps actually do

These comparisons concern the checked-out snapshots, not claims that their entire implementations are correct.

| App and revision | Useful mechanism | Evidence and limits |
| --- | --- | --- |
| T3 Code `cd096b9a` | Resolves descriptors once, then derives both displayed effort and dispatched option selections. Draft selections are scoped by provider instance. | `ignore/t3code/apps/web/src/components/chat/composerProviderState.tsx:58`, `apps/web/src/composerDraftStore.ts`. `apps/server/src/codexModelOptions.ts` still maps boolean false to omission, so it is not proof of correct explicit speed reset. |
| Monocode `568f246` | Builds typed model settings from the runtime catalog; handles both `serviceTiers` and `additionalSpeedTiers`; adds a Standard option. | `ignore/monocode/src/lib/harness/codexCatalog.ts:169`. `codexProtocol.ts:73` omits the `default` tier from requests. Its Standard label therefore needs checking against inherited provider config before copying it. |
| Omnigent `3b653b92` | Tracks active thread model and reasoning, mirrors provider changes into session metadata, and distinguishes default effort from an unseeded observation. Filters effort levels using the current model. | `ignore/omnigent/omnigent/codex_native_forwarder.py:319` and `:2977`; `web/src/pages/ChatPage.tsx:4146`. No equivalent end-to-end fast-mode guarantee was established in this inspection. |
| ORCA `b6d5972e` | Explicit value provenance and unknown state. A shared resolver chooses the model for both rendering and applying settings. Unsupported live changes have disabled reasons. | `ignore/orca-stably/src/shared/native-chat-session-option-snapshot.ts:169` and `:203`. It only names a CLI default when catalog metadata explicitly proves that default, and avoids pretending unknown toggle state is off. |

ORCA's provenance and T3's shared display/dispatch resolution are the strongest patterns to adopt. Copying a polished picker alone would preserve Mako's underlying bugs.

## Proposed correction

Keep capability catalogs separate from resolved settings. Provider modules should report effective configuration in the actual workspace and account/executable context, plus provider-confirmed session settings. Each setting needs a value and source, including unknown. Speed should retain the provider's semantic choices instead of being inferred from an option label.

Resolve the next turn in state, once. Explicit edits for that thread/draft take precedence; otherwise an existing thread uses confirmed session settings. New drafts use intentional saved preferences, then effective provider configuration. Only use a catalog fallback when it is applicable and proven. The same resolved result supplies the picker and dispatch. Reconcile provider acknowledgements back into state. Preserve an unknown or inherited value until resolved instead of showing an invented model, medium effort, or Fast off.

In the UI, show the actual next-turn model, `High reasoning`, and `Fast` or `Standard` when known. Explain inherited defaults in the menu. When the provider has not confirmed a value, say `Provider default` or `Unknown` as appropriate. Keep pending changes scoped to the thread/draft and expose unsupported changes accurately.

Migration must preserve intentional user choices. Existing imported preferences have no provenance, so blindly deleting all tuning would lose real choices. Introduce source-aware settings, retain legacy values as unclassified overrides, and provide a deliberate reset-to-provider-defaults action. Correct cache schemas and invalidate incompatible old snapshots.

## Verification

`npm run test:tuning` runs production-code regressions for the original findings, preference migration, display/dispatch parity, live acknowledgements, account/workspace invalidation, ACP application/rejection, Codex speed aliases and reset, Claude precedence, Cursor parameters, and Devin variants. The original `reproduce.mjs` now asserts corrected behavior.

`npm test --workspace @mako/sessions` covers shared settings plus latest native observations, bounded reads, native-store integrity, content fidelity, streaming, and continuation. `npm run test:live` covers persisted per-request settings, duplicate receipts, queued dispatch, recovery, and provider lifecycle. `npm run test:web` validates the regenerated IPC argument contract and both web/preload bridges.

Real-host UI checks use an isolated Electron user-data directory with the normal native catalog, provider discovery, workspace, and git state; no fixture mode or agent prompt is needed. Claude showed configured High reasoning with unknown speed unselected; selecting Standard and resetting restored the unknown state. Codex showed GPT-6-Astra, Medium reasoning, and checked Standard from workspace configuration. The final UI showed one Fast choice despite both catalog formats. Selecting a different model in one native thread survived switching away and back, did not leak into another thread, and reset correctly. Unobserved existing settings are labelled unknown.

Provider settings that a transport does not report remain unknown; an unsupported live change is disabled or rejected before prompt dispatch. These tests do not claim a live billable turn on every installed provider.

Final checks passed: `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test:web`, `npm run test:tuning`, `npm run test:live`, `npm run test:providers`, `npm run test:codex-protocol`, and the full sessions-library suite. ESLint retains two existing TanStack virtualizer compatibility warnings; anti-slop reports zero errors and zero warnings.
