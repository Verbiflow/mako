# Transcript presentation audit

Recorded September 8, 2026. This is a content-fidelity audit, separate from the successful browser-control workflows in the September 7 report.

The implementation follow-up below resolves the concrete import and presentation defects found in this audit. The original observations are retained afterward as historical evidence. This is not a claim of complete native visual parity.

## Implementation follow-up

The shared transcript now resolves local Markdown and attachment media through the owning conversation's authorized file transport. It loads offscreen local previews lazily, provides image expansion and explicit missing-file states, and recognizes audio/video embeds. Image-only and empty tool results are complete; returned images remain inside their owning tool row. Tables retain readable headers, scroll horizontally, and expand into a dialog. Settled visible code loads Shiki syntax tokens using Mako's color variables. Mermaid renders into an expandable image with a source toggle, bounded input, strict security, browser-resolved theme colors, and intrinsic SVG dimensions.

Provider-owned translations now preserve Claude slash-command prompts, hide recognized interruption scaffolding, normalize Codex prompt/question/image envelopes and review directives, and turn Devin references into file links. Literal XML and directive examples inside code remain literal. Structured nested MCP calls expose their supplied operation names; arbitrary execution code is not guessed. Expanded reasoning uses the shared Markdown renderer. Native tool plans and ACP plans render completion summaries.

Typed diffs, terminal references, plans, and tool attachments survive host updates, renderer state, native import, journal restart, archives, and text replay. Live ACP plus native Devin and Grok ACP readers preserve structured content. A terminal identifier remains visible with an explicit explanation when no reconnect transport is supplied.

Cursor desktop workspace/global storage is now discoverable alongside CLI/ACP storage. The reader selects bounded native records and skips background notification traffic. Its follower checks conversation revisions so unrelated database activity does not replace the open transcript. Desktop histories expose their actual continuation limitation; a reply starts a new provider session with context. They are not incorrectly marked archived.

Cursor Canvas previews are registered through a provider capability. A bounded compiler builds an opaque, sandboxed iframe supporting the observed `cursor/canvas` components and local interactive state. Source remains accessible. The artifact never executes in the host; filesystem, Node, and network imports are rejected. Host actions are shown as unsupported, and preview state is temporary.

### Verified interactions

- In the real Mako host, **System comparison and cloning** is now found by title. Its saved **Letta Vs Arca Memory Review** Canvas renders its cards and comparison table. Selecting **Steal and avoid** changes the document content.
- In the real native Claude CleanShot history, expanding **Work log · 12 commands · 1 read · 1 failed** and its Read shows the retained image inside the completed result. **Expand image** opens the actual 1,999-pixel image. The incorrect waiting label is gone.
- The explicit browser fixture at `/scripts/transcript-browser.html?mock` verifies local and URL images, a missing-file message, audio/video control elements, and offscreen deferral (two initial file reads; the third file stays deferred). It also verifies image and diagram dialogs, nonzero Mermaid dimensions, loaded syntax token spans, formatted thinking/file references, typed diff rows, terminal fallback, completed plans, and expanded table headers. Audio/video playback was not established by this fixture.

### Regression coverage and limits

`npm run test:transcript` includes provider normalization, literal-content preservation, tool ownership and completion, citation parsing, actual ACP-to-journal-to-archive-to-renderer persistence, replay content, syntax token generation, and Canvas compilation/import restrictions. The sessions suite additionally exercises native Cursor desktop SQLite discovery/following, exact image bytes, native Devin/Grok structured content, archive retention, large native stores, streaming convergence, and cross-provider replay.

`render-evidence-fixed.json` is the updated server-rendered evidence; `render-evidence.json` retains the original audit output. The reproduction now includes the owning Codex normalization before rendering Codex directives. Lazy media and syntax rendering require the browser fixture, so static markup alone does not establish their behavior.

Validation: `npm run typecheck`, the full sessions suite, `test:live`, `test:codex-protocol`, `test:web`, `test:transcript`, `npm run lint`, and the production build passed. Provider composition/activity, host, performance, and standalone thread-opening checks also passed. The subsequent stage-test follow-up replaced the blanket infinite-animation ban with checks for paused ocean layers, visibility/preference gating, composition pause, and reduced motion. It also verifies the retained ACP plan block. `npm run test:stage` now passes. ESLint retains its two existing TanStack compiler warnings; Oxlint reports zero warnings and errors. No provider prompts or historical commands were sent or rerun.

The temporary fixture tab and the verification web host were closed after checks.

Remaining verification limits: Computer Use still rejects the native Codex app, so that direct comparison remains unavailable. The historical sample is still not five rich pairs per provider. Canvas support covers the observed component contract, not Cursor's design/share/host-action APIs. Missing native media bytes cannot be reconstructed. A provider terminal requires an actual reconnect capability before Mako can attach to it.

## Original audit observations

## What was actually compared

| Provider | Direct UI observation | Native record check | Limits |
| --- | --- | --- | --- |
| Codex | Opened **Audit Mako session handling**, this exact conversation, in the real Mako web desk at port 5174. Confirmed its latest prompt and previous answers. | Read the separate successful browser fixture through `CodexProvider`; it retains one inline screenshot. | Computer Use rejected access to `com.openai.codex`. No alternate capture was attempted. A same-session screenshot comparison against Codex itself remains blocked. |
| Cursor | Opened Cursor Agents and **Cleanshot X crashes and lag investigation**. Observed grouped work, rendered tables, copy actions, and Files/Browser/Terminal companions. | Read the actual **Browser Integration Test** ACP store through `CursorProvider`. Found and fixed lost image parts. | The desktop conversation explicitly says **Imported from Claude Code**. It proves Cursor's rendering of Claude history, not a native Cursor agent run. Mako's reader covers Cursor CLI/ACP roots; its coverage does not establish import of every Cursor desktop conversation. |
| Claude Code | Directly inspected five populated sessions in authenticated Claude Desktop and matched all five in Mako. See the expanded comparison below. | The successful Claude browser fixture retains two inline screenshots. The billing session also reproduces omission of its slash-command prompt and missing catalog title. | Archived remote file previews may be unavailable; that is distinct from a missing preview control. |
| Devin | Opened **Investigate streaming and implement fork** in Zed's Devin panel and the same title in Mako. Zed shows individual edited-file rows and expanded, formatted thinking with clickable file references. Mako groups this work under expandable work logs. | Read the successful `blend-triangle` fixture through `DevinCliProvider`; it imports 30 tool calls and no images. | The sampled native tool records were text and did not contain image data URIs or base64 image payloads. This does not establish whether another Devin store or host journal retains the missing bytes. |
| OpenCode 2 | Read the checked-out OpenCode session UI, including its V2 attachment cards and image-preview action. | Read the actual V2 session `ses_f802b26f7ffeEOOVAr2IGgoI21`; fixed its unavailable screenshot. | No direct OpenCode 2 desktop/TUI screenshot comparison was completed. Source observations are labeled as such. |

Mako was running its real host, without `?mock`. The shared development host reloaded during inspection, resetting the selected session more than once. Two offscreen work-log/file actions timed out in Computer Use, so those clicks are not counted as verified navigation.

The installed OpenCode 2 CLI advertises `--session`, and Claude advertises resume support. Attempting to use Ghostty for the native terminal comparison was also rejected by Computer Use for safety reasons. No alternative terminal or capture route was used to bypass the rejection. No new model prompt was sent during this audit.

## Fixed and verified

1. **Cursor MCP screenshots were discarded on import.** The native tool-result stores media alongside the structured result in `experimental_content`. `CursorProvider` only extracted attachments from `result`. It now preserves those separate media parts while keeping the original output and tool pairing. The same real session went from zero to two retained image attachments. `packages/sessions/test/cursor-tool-images.mjs` constructs the native SQLite/blob record shape and verifies exact attachment bytes and unchanged structured output.
2. **OpenCode 2 screenshots became unavailable.** The native file part uses `uri`, while `fileParts` only accepted `url`. It now accepts both provider forms. The same real session's image changed from `unavailable` to `inline`. The existing V1/V2 provider regression now includes an actual V2 `uri` image part and checks its bytes.

These are provider-owned translations into the existing shared attachment contract. No second transcript renderer or provider switch was added to the UI. Persisted archives or a running daemon may need a fresh native read before they reflect a reader fix; visual refresh of the existing desktop process was not verified.

## Findings recorded before implementation

| Priority | Finding and consequence | Evidence / owning code |
| --- | --- | --- |
| P1 | A Markdown image such as `![proof](/work/proof.png)` is rendered as an ordinary web URL. In the web desk it requests the dev server path, not the authorized native file. Local images returned by any agent can therefore break. | `render-evidence.json`, `local-markdown-image`; `src/components/transcript/markdown.tsx` has no image component. |
| P1 | Markdown audio/video conventions are not interpreted as media. The sampled audio embed renders an `<img>` rather than an audio player. | `audio-markdown-embed`; same renderer. Structured audio/video attachments already have player elements. |
| P1 | Local-file image attachments render only a filename button. Inline/URL images render pixels but have no expand action. Imported and live representations of the same screenshot can therefore look different. | `local-image-attachment` and `inline-image-attachment`; `src/components/transcript/attachment.tsx`. The composer already has a thumbnail/preview interaction, but the transcript does not reuse it. |
| P1 | ACP diff content is flattened into `File: path`, old text, and new text. Terminal content becomes a terminal-ID string. The shared event loses enough structure that a renderer cannot reliably reconstruct a diff or reconnect a terminal from that output. | `electron/acp-notifications.ts`, `toolContent`; `electron/contracts/live-content.ts` tool variants expose text output and attachments, not typed diffs or terminal references. |
| P2 | This Codex session displays literal `<image ...>` appendices alongside extracted images, and displays `<send_user_message_question_reply>` JSON as the user's message. Context/instruction turns also occupy the conversation and turn navigator. | Direct Mako AX/UI observation of **Audit Mako session handling**. `Prompt` in `src/components/transcript/exchange.tsx` handles Mako appendices but not these native provider envelopes. Avoid blanket removal of user-authored XML; normalize only recognized native records in the owning provider. |
| P2 | Codex review comments remain `::code-comment{...}` text. `codex://review` links are transformed into links with an empty destination. The user sees content that appears actionable but cannot perform the native action. | `codex-review-directive` and `codex-review-link`; production renderer reproduction. Other directive families have not yet been exhaustively tested. |
| P2 | Mermaid fences are displayed as code. Code blocks have a language label and copy action but no syntax highlighting in this renderer. | `mermaid` and `cursor-code-citation`; `CodeBlock` in `markdown.tsx`. |
| P2 | Reasoning uses a plain text summary/detail path. The Devin session's formatted thinking and its file reference are more useful in the native Zed view. | Direct Zed screenshot; `Thinking` implementation in `exchange.tsx`. The Mako work-log expansion was not successfully verified through Computer Use. |
| P2 | Outer execution-tool wrappers obscure the operation. In the sampled sessions Codex shows `exec`, Devin shows `mcp_call_tool`, and OpenCode 2 shows `execute`; Claude and Cursor expose the actual MCP names. | `native-evidence.json`. Normalize only when the provider supplies reliable nested-call metadata; do not infer an executed action from arbitrary code text. |

## Behaviors already present

Absolute and relative Markdown file links become thread-aware file buttons. File URLs, editor links, line suffixes, Codex file citations, and Cursor's `12:18:path` code fences have parser support. The production renderer reproduction verifies file-button output and Cursor code-range labeling, while `scripts/test-content-contract.ts` tests citation parsing. This audit did not prove every live file click.

Mako already preserves structured attachments, has audio/video elements for supported inline/URL sources, groups tools by exchange, and has shared file/diff companions. The missing work is to preserve all provider data and connect those existing capabilities consistently.

## Original implementation plan

1. Use one shared, lazy media component for Markdown and structured transcript attachments. Resolve local files through the owning thread/live-session state action and existing authorized file transport. Include an expand action, explicit unavailable state, correct audio/video controls, and cancellation when the source changes. Do not start one eager full-thread read per offscreen image.
2. Carry typed diffs and terminal references through the host event, session state, archive, and transcript. Preserve these fields on native import and replay. Keep provider-specific syntax in the provider adapters.
3. Normalize recognized prompt envelopes and action directives at provider boundaries. Preserve original user text and expose unsupported actions honestly instead of blank destinations.
4. Add a presentation fixture matrix using the five native formats, covering images in user/assistant/tool content, file lines/ranges, missing files, audio/video, diff edits, and replay after restart. Compare live and imported history for the same fixture. Then finish the direct native UI comparison, including Codex when capture is available.

## Reproduce

`node docs/public-audits/2026-09-08/transcript-presentation/reproduce.mjs` bundles and server-renders the real React components, then writes `render-evidence-fixed.json`. It reads no native conversations and launches no agent. This proves generated markup, not successful browser media loading or click behavior.

`node docs/public-audits/2026-09-08/transcript-presentation/native-inventory.mjs /path/to/manifest.json` reads explicit native session paths and writes only counts, provider IDs, tool names, and media-source kinds to `native-evidence.json`. The manifest is a JSON array of `{ "provider": "cursor", "path": "/absolute/native/store.db" }` objects. It does not print transcript text, media bytes, credentials, or scan the full catalog. The committed evidence uses the successful September 7 browser fixtures and reflects the two fixes above.

Run the focused regressions with `npm run -s build --workspace @mako/sessions`, `node packages/sessions/test/cursor-tool-images.mjs`, `node packages/sessions/test/opencode.mjs`, and `npx tsx scripts/test-content-contract.ts`.

Validation completed: the package build, Cursor image regression, OpenCode V1/V2 suite, citation regression, full `npm run typecheck`, and `npm run lint` pass. ESLint reports the two existing TanStack compiler warnings; Oxlint emits no warnings or errors. `git diff --check` passes. The Cursor regression is included in the sessions package's normal test command. Full native desktop visual parity remains unverified for the reasons above.

## Reference sources

- [Claude Code Desktop](https://code.claude.com/docs/en/desktop#preview-your-app) documents opening local HTML, PDFs, images, and videos from chat into its browser pane. This is documented behavior, not a local screenshot observation.
- [OpenCode TUI](https://dev.opencode.ai/docs/tui/) documents file references. The richer image preview observation is from the local OpenCode source at commit `101ff6d1a2e55c57419aaeaeebf466a180c95011`, `packages/session-ui/src/components/message-part.tsx`, around `renderAttachments`, and its imported V2 attachment-card component. TUI and desktop behavior must not be conflated.
- [Official OpenAI feature documentation](https://learn.chatgpt.com/docs/features) was consulted, but it does not substitute for the blocked same-session Codex visual inspection. The tested Codex directive examples come from this session's actual content contract.


## Expanded rich-session comparison

The follow-up uses populated historical conversations, not the short browser fixtures. Five Claude Desktop conversations have now been visually matched against the same content in Mako. Desktop titles differ from Mako's first-prompt labels.

| Claude Desktop title | Same conversation in Mako | Observed difference |
| --- | --- | --- |
| Cleanshot X crashes and lag investigation | `can you look into cleanshot x and why its so laggt and crashing constantly? Check the local logs and stuff as well pls` | Claude groups commands under descriptive summaries and shows the created `mochi-agent-run-interruption-test-spins.md` as a numbered, syntax-styled addition diff. Mako also has a green addition diff after expanding its work log and Write row. Mako's collapsed command labels expose raw shell strings, and its diff lacks the same line-number treatment. This is a polish gap, not wholesale absence of edit previews. |
| Arca information | `Did arca give you this info?` | Both render the three-ledger table. Claude offers Expand table and opens `backend/flage/bridge/routes/billing.py` from inline code as a file companion. The archived companion then explicitly reports that the session/file is unreachable. Mako leaves that inline-code path as text and has no table expansion control. Claude's MCP tool exposes labeled parameters and a copyable result; Mako's sampled row did not expand during this inspection. |
| Flage billing and credit accounting | `Untitled session`, Claude model `claude-fable-5`, August 31 | Matching graph-query commentary and headings confirm identity. Claude retains the initial `/graphify` question. Mako starts with the assistant and cannot be found by the native title or that question. The local native file is `04f45cae-6758-4de4-ba62-a493a8c40bd8.jsonl`; its parsed history has 55 entries, and the bounded catalog peek has no title. This is a prompt/import and discoverability gap. |
| Continuity camera focus loss | First prompt beginning `i have continuity camera connected via iphone` | Both retain the two diagnostic exchanges and failed command. Claude describes the operation; Mako labels it with the shell command. Mako additionally renders `[Request interrupted by user for tool use]` as a user bubble and navigation target. |
| Podcast name brainstorming | `Can you set this up please: https://github.com/diffusionstudio/editor`, the open Claude session under pods | Matching naming replies and the final captioning explanation confirm identity. Both preserve code blocks, lists, and the caption example's line breaks. Claude turns `scripts/transcribe.sh` and `scripts/cues.py` into file-preview buttons; Mako keeps them as inline code. Claude folds the two commands into one summary; Mako shows both raw command rows. |

The empty `kashyabs-macbook-pro-2-local-serialized-sunrise` session is excluded from the count. No prompts were sent and no historical commands were rerun.

### Additional provider observations and incomplete coverage

- Cursor Agents rendered five rich histories. Cleanshot X crashes and lag investigation, Define core primitive and UI for outreach platform, Debug sender profile pictures not displaying, and Rebuild arca with new changes explicitly identify themselves as imported from Claude Code. System comparison and cloning is a native-looking Cursor conversation with Cursor feedback/fork controls and a saved Canvas, with no import label. The architecture thread has a per-answer changed-file card with Review and additions/deletions. The sender thread itself displays a raw `[Image #1]` placeholder. These observations describe Cursor's import renderer, not native Cursor execution fidelity.
- Zed's Devin panel eventually loaded all five sampled histories, and all five were matched in Mako. See the paired observations below. Initial loading delays did not indicate missing histories.
- Installed official OpenCode Desktop 1.18.29. Normal startup displayed the V1 test history. Its V2 launch flag failed because the downloaded app omits `Contents/Resources/opencode-cli`. The existing OpenCode 2 service serves a graphical beta UI, but unauthenticated requests caused repeated sign-in prompts. Closed that tab and stopped the desktop experiment. Authentication is required before further visual inspection. No service authentication was disabled and no app bundle was modified.
- Codex's direct native UI remains uninspected because Computer Use rejected access to the app. The Mako side of this exact conversation was inspected. No alternative capture route was used.

The requested five rich threads per provider is **not complete**. Five Claude pairs and five Devin pairs are complete; the counts above must not be presented as 25 successful comparisons. The remaining providers need native UI access or successful history loading before parity conclusions can be made.

### Resource cleanup

After the user reported excessive load, the temporary OpenCode and Mako browser tabs were closed, the comparison viewport override was removed, and the Cursor app launched for inspection was quit. On the user's subsequent explicit request, the long-running Next.js process 89315 was terminated; both it and parent 89304 were confirmed absent. Existing agent sessions and the OpenCode 2 service were left running. Subsequent comparisons reuse the existing Chrome Mako tab and the already-open Claude app.


The five matched Claude native records contain 546 parsed entries and 253 tool calls. Two retain an inline JPEG. `claude-rich-manifest.json` identifies those exact records and their desktop titles; `claude-rich-evidence.json` contains counts and attachment kinds without transcript bodies. Reproduce with:

```sh
node docs/public-audits/2026-09-08/transcript-presentation/native-inventory.mjs docs/public-audits/2026-09-08/transcript-presentation/claude-rich-manifest.json docs/public-audits/2026-09-08/transcript-presentation/claude-rich-evidence.json
```

Further direct image check: in Claude's Cleanshot session, expanding **Read CleanShot 2026-09-01 at 2.00.17 PM@2x.png, ran 3 commands**, then its Read row, displays the retained screenshot inline and a clickable source path. The image is visible even though the session is archived. This is confirmed historical media rendering, separate from opening a current file in an unreachable remote session.

Paired image result in Mako: the same screenshot renders after expanding **Work log · 12 commands · 1 read · 1 failed**. Opening its Read row shows the file-path JSON and **waiting for result…**, while the already-returned image appears below and outside that row. Claude places the image inside the completed Read result. Preserve image-only tool completion and attachment ownership; do not equate an empty text result with an unfinished tool. This is a directly observed status/grouping bug, not a missing-byte claim.


### Five rich Devin pairs

| Zed Devin title | Matching content in Mako | Observed difference |
| --- | --- | --- |
| Investigate streaming and implement fork | Same titled conversation and streaming/fork discussion | Zed shows individual changed-file rows and formatted thinking with clickable file references. Mako groups operations in work logs and renders thinking as plain text. |
| Email World Class Analysis & Sequencing | Final explanation of why the count is 12 rather than 11, including the 3,904 projection | Both preserve the answer and code blocks. Zed has a persistent completed four-step plan. Mako exposes a generic `todo_write` tool without the same completed-plan presentation. |
| Enhance Sequence Audience UI and Performance | Same final bounce-handling explanation | Zed turns native file ranges into clickable references and renders an Image badge. Mako exposes literal `ref_snippet` tags and an `[Image 1: /Users/...png]` marker. The native badge did not open image pixels during this inspection, so image-byte availability remains unproven. |
| Together AI via Verbiflow | Same Local fix and Current status sections, including 21 passing tests | Zed renders `QuickAccessPanel.tsx:291-305` as a clickable file reference. This is a useful presentation pattern for the native reference metadata. |
| Figma Email Inbox Design Review | Same Verification table and Files changed section | Both render the table. Zed makes `frontend/tsconfig.json` and `frontend/README.md` clickable. Mako leaves these inline-code paths as text. |

These comparisons only read historical conversations. The historical test and deployment statements in those answers were not independently rerun.


### Additional Cursor comparisons

- **Rebuild arca with new changes** is the Claude import at `~/.claude/projects/-Users-kashyab-repos-nu-arca/8b5c725a-c6a0-43ad-99c8-1da2eb36f5f1.jsonl`. Mako finds it as **plese rebuild arca since we have pulled in new changes**. The same final stale-build explanation, source hash, and hooks discussion rendered in both apps. Cursor shows the user's screenshot as `[Image #11]`. Its companion Changes panel displays numbered, syntax-colored diffs, but that panel is scoped to current uncommitted workspace changes and must not be confused with the historical answer's edits.
- **System comparison and cloning**, under Arca, has a saved **Letta Vs Arca Memory Review** Canvas. Opening it renders a live interactive document in the right companion. Clicking Verdict switches its content from Steal and avoid to the comparison view. Canvas, source-view, design-mode, and share controls remain beside the artifact. The answer also has a Markdown document link and a one-file changed card with Review and `+616` lines. No publish, design, commit, or agent-run action was taken.
- Searching Mako for **System comparison** returns **Nothing matches**. Mako's Cursor adapter discovers `~/.cursor/chats` and `~/.cursor/acp-sessions`, not Cursor desktop workspace/global storage. This establishes a title-search miss and a reader-coverage limit. It does not prove the same conversation is absent under every possible alternate title. Its saved Canvas has no verified Mako counterpart.

Five Cursor source conversations were visually inspected, four of them Claude imports. This is not five native Cursor pairs. In particular, a native-looking conversation with a working saved Canvas is materially richer than the earlier CLI browser fixture and exposes an artifact/discovery gap the fixture cannot measure.


After the expanded comparison, Cursor and the audit-launched Zed process were stopped. The audit's real Mako web host was also stopped. Its Electron host, Zed, and their inspected child processes were confirmed absent. The existing user Chrome tab was left open. Codex native capture and OpenCode 2 authentication remain unresolved, so this report does not claim completion of the requested five native comparisons per provider.


## Authenticated OpenCode 2 follow-up

The user supplied pairing credentials and explicitly authorized access. Authentication through OpenCode's supported pairing URL succeeded. No credentials are included in this report. The beta web UI at the user's local OpenCode 2 service was inspected through Computer Use. Five exact titled histories were then opened in Mako's real web desk. Earlier authentication limitations above describe the prior attempt and are now resolved.

| OpenCode 2 title and native ID | Paired visual finding |
| --- | --- |
| Diffusion Studio podcast clips and transcript, `ses_fa563268fffepnipceVNwxGb1r` | Substantial history with 7 Read, 1 Webfetch, and 36 Shell operations. Both interfaces preserve the final setup answer, clip rankings, code line breaks, and two unanswered follow-ups. Both expose raw shell commands when work groups expand. Neither sampled answer turns its inline-code file paths into file buttons. |
| Backfilling raw session transcripts via script, `ses_fd92ccce3ffeaiL8VyWC1tQXrn` | Substantial history with long analysis and tables. The same final deletion-candidate table renders in both. OpenCode uses a wider table with horizontal separators. Mako's narrower bordered table splits the Confidence heading across lines. Content survived; table sizing and wrapping need improvement. |
| Diffusion Studio podcast clip and transcript setup, `ses_fa564507dffeVwwwl5pLbkworo` | A shorter no-tools answer with code examples. Both preserve the code blocks, line breaks, and copy controls. This is formatting coverage, not a rich execution history. |
| transcript.md bundle integrity review, `ses_fd1bb4db9ffe8Tx2Ekdma23iZk` | An interrupted one-read test, excluded from the rich-history count. Both show Interrupted. Mako additionally exposes the failed Read row without opening a tool group. |
| Browser fixture verification with square counts, `ses_f802b26f7ffeEOOVAr2IGgoI21` | Seven Execute tools. Expanding the screenshot Execute in the native beta UI displays code and JSON, with no image or attachment action in the observed result. After expanding Mako's work log, the retained screenshot renders inline. This visually verifies the earlier V2 uri import fix. Source-level attachment-preview support must not be presented as proof this native result displays pixels. |

The similarly prompted Mako entry **Can you set this up please: https://github.com/diffusionstudio/editor** is a separate single-prompt session. The completed podcast history is discoverable by its actual **Diffusion Studio podcast clips and transcript** title and was used for the comparison.

This adds five paired OpenCode observations, including two substantial histories and three narrower cases. It does not satisfy five rich histories per provider. Codex's native app access remains explicitly rejected by Computer Use with the message that `com.openai.codex` is not allowed for safety reasons. No alternate computer-use provider was used to circumvent that restriction.
