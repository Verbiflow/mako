# Harness settings verification — September 8, 2026

The reported Claude session contained native `effort: "high"` while its Mako journal had empty options. Its requested model also included `[1m]`, which the Fable API message omitted. The repaired composer resolves that exact saved session to **Fable, High reasoning**, with no validation issues, and retains the explicit context selector when sending.

## Changes

- Claude discovery disables session persistence and reads one model at a time to avoid creating history entries or spawning four CLI processes at once. Failed refreshes preserve the last complete workspace/account settings and expose the error.
- Claude defaults come from the CLI's `get_settings` applied configuration for each reported model. Only effort and fast-mode facts leave the response parser; unrelated effective settings and credentials are discarded.
- Claude native scans retain effort and usage speed, exclude sidechains, and recover workspace/title metadata after large attachment records within the existing bounded tail scan.
- Restored live conversations also locate their native session by provider and native ID, even when no native thread view is open. Incomplete live snapshots can use native observations for the same model. Explicit live values and pending user selections still win. Model identity matching understands Claude's context selector and preserves it at launch.
- Cursor's Thinking and Effort controls have distinct IDs. Fast retains its speed role. The provider contributes `parameterizedModelPicker: true` to ACP initialization, enabling its real parameter controls.
- Cursor and Grok discovery retain their reported current settings. Cursor native IDs with bracketed parameters are decoded where recorded.
- OpenCode v2 can return an empty successful model list when first registering a workspace. Discovery retries that empty response once and rejects a persistently empty catalog. Native session model variants now retain reasoning effort.
- Devin resolves its default model through a no-prompt ACP session and deletes that probe session afterward. The installed account reports `swe-1-7-medium`.
- OpenCode 2 reads `/api/model/default` through its own CLI instead of trying to parse configuration-source documents as resolved settings. The installed account reports `amazon-bedrock/us.openai.gpt-6-astra`; the earlier end-to-end test used the accessible OpenAI model explicitly.
- The native catalog cache version advances so unchanged files are re-read with the corrected parsers.

## Real installed-provider checks

Each provider ran through Mako's real host in a disposable workspace, read a unique value from a file using its tool, and returned that value. No fixture-mode UI or mocked provider responses were used. Settings checks also changed effort when the live transport exposed that control. The repeatable test now restores the original effort after those changes; the initial Cursor test's original High setting was restored through its own ACP control.

| Provider | Models discovered | Settings observed through completion | Effort change tested |
| --- | ---: | --- | --- |
| Claude Code | 4 | Fable; High initially, Low after change | High → Low |
| Codex | 7 | GPT-6-Astra; Medium; Standard speed | No effort control advertised in this session snapshot |
| Cursor | 38 | Opus 5; Thinking on; 300K context; Standard speed | High → Low |
| Grok | 2 | Grok 4.6; High | No turn-time effort control advertised |
| Devin | 46 | `swe-1-7-medium` selected by the provider | Variant selection carried by model identity |
| OpenCode | 186 | OpenAI GPT-5.6-Luna | None → Low |

[Machine-readable installed results](installed-results.json) combine the six-provider run and the successful Cursor rerun after capability negotiation was corrected. The OpenCode native settings in that report were refreshed with the corrected parser and are also covered by a native database regression test.

OpenCode's configured default attempted a Bedrock model unavailable to this account. The successful test explicitly selected an accessible OpenAI model in its disposable session. Neither Devin's model-list response nor OpenCode v2's unavailable legacy `debug config` command reported a startup default; live startup supplied it. Cursor's tested native store omitted model/settings, and Codex's tested native record omitted speed. Historical values absent from the native store are not guessed from today's defaults; Mako-owned sessions retain their acknowledged live settings in the journal.

## Reproduce

```sh
npm run build:electron
MAKO_E2E_MODELS='{"claude":"claude-fable-5-1","opencode":"openai/gpt-5.6-luna"}' node scripts/test-provider-e2e.mjs --settings
```

The model overrides above reflect models available to the tested accounts. The test prints its evidence directory, records startup/completion/native settings, rejects empty catalogs and duplicate control IDs, and verifies real file-tool output.

## Validation

Passed: `npm run typecheck`, `npm run test:tuning`, `npm test --workspace @mako/sessions`, `npm run test:providers`, `npm run test:live`, `npm run test:live-actions`, `npm run lint`, and `npm run build`. Oxlint reports zero warnings/errors. ESLint retains its two existing TanStack/React Compiler compatibility warnings; production build retains its existing bundle-size warnings.

The real web host also displays **Fable → High reasoning** when selecting Fable. The original saved journal plus its native file were passed through the same composer resolver used by display and dispatch; the result was High from the session, with no issues.

## Installed application

The corrected app was packaged locally without publishing, its signature and bundled provider files were verified, and `/Applications/Mako.app` was replaced after confirming its owned conversation was idle. The previous bundle is retained at `/tmp/mako-harness-settings-backup/Mako.app`.

## Inline attachments follow-up

- Filename chips replace numbered draft references, preserve the reference's position in the sentence, and open a preview. A close button removes both the reference and its outgoing file.
- Backspace/Delete and partial selections remove a whole reference. Native undo restores the attachment; discarded payload bytes are not kept merely for undo.
- Older sent messages render their original filenames in place of `[Attachment N]`, without the duplicate generated scratch filename below. Reuse carries the actual staged files back into the composer.
- Restored files without text markers receive visible references. Legacy draft normalization keeps the original captured text for conditional clearing, preserving paragraphs typed while staging or sending.
- The model picker shows actual discovered models. Loading and failures are labelled explicitly instead of being called “Provider default.” Claude models without fast-mode capability show Standard with an explanation on the disabled control.

`npx tsx scripts/test-attachment-references.ts` verifies partial deletion, multi-file replacement, duplicate names, absence of detached files from the outgoing prompt, persistent references, legacy transcript conversion, file-only prompts, and reuse. The check is included in `npm run test:live`.

The real host UI was exercised on the user's original Claude thread: Reuse restored the named image, Backspace and Delete removed it, Undo restored it, and the close button detached it. No user prompt was sent during those UI checks.
