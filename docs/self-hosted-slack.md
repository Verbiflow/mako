# Run your own Mako Slack bot

Mako does not require the project’s Slack app. You can create a Slack app in
your workspace, deploy the backend from this repository, and point the desktop app at
that deployment.

```text
Slack Agent view → delivery adapter → durable relay → headless worker → local provider process
```

The backend never runs a model. It verifies Slack, queues work while the worker
is offline, and projects the worker's canonical text, reasoning, tool, plan,
permission, and lifecycle events into Slack Thinking Steps. Generated files
return through the same delivery adapter without exposing Slack credentials to
the worker. The provider-neutral worker core is shared by Electron and headless
Node hosts, so a self-hosted daemon or VM does not introduce a second runtime.
Slack itself is registered as a delivery adapter; Teams, Discord, or another
gateway can implement that contract without editing Slack delivery code.

## 1. Create the Slack app

Create an app from scratch in the Slack workspace you control.

Enable Slack’s **Agent** feature and use the `agent_view` messaging experience.
Add these bot scopes:

- `app_mentions:read`
- `assistant:write`
- `channels:history`
- `chat:write`
- `commands`
- `files:read`
- `files:write`
- `groups:history`
- `im:history`
- `mpim:history`

Enable Event Subscriptions and subscribe to `agent_session_stopped`,
`app_context_changed`, `app_home_opened`, `app_mention`, `message.channels`,
`message.groups`, `message.im`, and `message.mpim`. The stop subscription is what
turns Slack’s processing indicator into a native Stop button. Set the Request URL to:

```text
https://YOUR_BACKEND/api/slack/events
```

Use the same URL for Interactivity. Optionally add a `/mako` slash command with
that Request URL. Install the app, then copy its bot token and signing secret.

## 2. Provision the durable relay

Create an Azure Storage account and a service principal scoped to that account.
The backend uses Queue Storage for durable jobs and Table Storage for jobs,
worker registrations and heartbeats, thread mappings, and replayable canonical
events. Pending queue writes and queue deletions are reconciled from durable job
state after partial failures.

Create the queue and tables before deploying:

```bash
az storage queue create --name mako-jobs --account-name "$AZURE_STORAGE_ACCOUNT_NAME" --auth-mode login
for table in MakoJobs MakoWorkers MakoThreads MakoRegistrations MakoEvents; do
  az storage table create --name "$table" --account-name "$AZURE_STORAGE_ACCOUNT_NAME" --auth-mode login
done
```

Copy the backend environment template:

```bash
cp packages/backend/.env.example packages/backend/.env.local
```

Set:

```dotenv
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
AZURE_STORAGE_ACCOUNT_NAME=...
AZURE_TENANT_ID=...
MAKO_MCP_TOKEN=generate-at-least-32-random-characters
RELAY_BOOTSTRAP_SECRET=generate-at-least-64-random-characters
RELAY_TOKEN_SECRET=generate-a-different-64-character-secret
RELAY_ALLOW_LEGACY_TOKEN=false
SLACK_ALLOWED_USER_IDS=U01234567
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_TEAM_ID=T01234567
```

`SLACK_ALLOWED_USER_IDS` is a comma-separated allowlist. Mako rejects events
from every other user even when the Slack signature is valid. The MCP token is
the one-time desktop bootstrap credential; each Mac registers its own random
secret and exchanges signed challenges for five-minute tenant/device-scoped
relay tokens. Leave `RELAY_ALLOW_LEGACY_TOKEN=true` only while upgrading older
desktops, then set it to `false`.

Deploy `packages/backend` to any platform that runs Next.js route handlers. The
included Vercel deployment remains one option, not a requirement. If you prefer
Vercel Connect, leave `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` empty and set
`SLACK_CONNECTOR` instead.

## 3. Connect the Mac

Point the desktop process at your backend and store the matching MCP token in
macOS Keychain:

```bash
security add-generic-password -U \
  -s dev.mako.backend.mcp \
  -a "$USER" \
  -w 'YOUR_MAKO_MCP_TOKEN'

MAKO_BACKEND_URL=https://YOUR_BACKEND/api/mcp npm run desktop
```

Packaged builds can be launched with `MAKO_BACKEND_URL` from a wrapper or MDM
profile. On first relay contact Mako registers the installation and writes its
separate device credential to the `dev.mako.backend.relay` Keychain service.
Both credentials stay in Keychain and never cross the renderer bridge.

Only the installed app's default profile serves remote work. A `dev`, sandbox,
or test profile (`MAKO_PROFILE`, `--sandbox`, `MAKO_DATA_ROOT`) leaves the
relay off so a development host cannot lease requests meant for your Mac;
set `MAKO_RELAY=1` to opt one in, or `MAKO_RELAY=0` to keep the installed app
out. An opted-in profile registers as `<hostname> (<profile>)` so Slack's
`status` says which one answered.

### Where a request runs

A Slack thread runs in one project directory on one Mac. Mako never uses the
app process's working directory (a packaged app starts in `/`). The first
request in a thread runs in the project you worked in most recently; send
`projects` to see the candidates and `project <name-or-path>` to pin the
thread to one. After that the thread's project and tuning are remembered, and
`new` starts a fresh session in the same project. A pinned project that no
longer exists is an error that asks you to choose again, never a silent
fallback. Incoming attachments are staged under Mako's own data directory,
not inside your repository; the only thing a run leaves in the project is
`.mako-relay/<job>/outbound-files.json`, which is removed when the run
settles.

## 4. Verify it

1. Open Mako and confirm **Settings → Integrations → Mako Backend** is ready.
   Its detail names the relay too: `Relay listening as <Mac> · checked 3s ago ·
   new requests run in <project>`. `Relay off: …` means this profile does not
   serve remote work; `Relay failing: …` names the failing call and when it
   retries.
2. Mention the bot in Slack and send `status`, then `projects`, and pick one.
3. Send `new codex Reply with exactly OK` and confirm Slack shows the native
   processing state, Stop button, reasoning/tool/plan task updates, and streamed
   answer.
4. Send two messages quickly and confirm the second remains queued for the same
   local session.
5. Attach an image or file and confirm the local agent receives a staged path.
6. Ask the agent to create a file and confirm it returns in the Slack thread.
7. Send `threads` and `models`; choose a returned thread or model from the live
   Block Kit controls and confirm the Slack thread mapping changes.
8. Quit Mako, send another request, reopen Mako, and confirm the queued request
   completes in the same Slack thread with stored events replayed once.

Useful commands include `projects`, `project`, `threads`, `resume`, `new`,
`queue`, `steer`, `stop`, `harness`, `models`, `model`, `reasoning`, `fast`,
`status`, and `help`. Plain
messages resume the session mapped to that Slack thread; while it is working,
plain messages queue in arrival order. `steer` stops the current native turn and
puts the new message next rather than pretending every provider can steer live.

## Operations and troubleshooting

- `401 Unauthorized` on the event URL means the signing secret or Slack clock
  skew is wrong. Mako deliberately returns no more detail to Slack.
- `status` reporting the Mac offline means the backend is healthy but no desktop
  heartbeat is current. Check `MAKO_BACKEND_URL` and the Keychain token, then
  the Mako Backend detail in Settings: `Relay off` names the profile gate and
  `Relay failing` names the failing relay call. When the Mac is online,
  `status` also says what it is doing (`working on a request now`, or which
  project new requests run in), from the worker's own heartbeat.
- The relay keeps its own log at `~/Library/Application Support/mako/logs/
  relay.log` (the detached host's console output is not kept): worker start,
  each lease and completion with its job id, and distinct failures. It rotates
  once at 1 MiB to `relay.log.1`.
- A thread pinned to a Mac that is offline queues for that Mac and says so,
  because its session and project exist only there. `new <message>` starts on
  any online Mac instead.
- `Mako could not run this on <Mac>: … (job 29ba3a8f)` in Slack is the
  worker's own error, not a backend one. The `job` reference is the first eight
  characters of the job id; search `relay.log` for it. A missing project
  directory asks you to send `projects`.
- Old worker rows from profiles that no longer exist clutter the fleet. From
  `packages/backend`, `node --env-file=.env.local --import tsx
  scripts/prune-relay-workers.ts --older-than=7d` lists them; add `--delete` to
  remove them and their registrations. Devices a thread is pinned to are kept.
- A queued request that never leases usually means the Azure service principal
  cannot access Queue or Table Storage.
- Rotate the bot token and signing secret in Slack, update both backend
  variables together, then redeploy. Partial direct credentials are rejected at
  startup rather than silently falling back.
- Back up the Azure tables if Slack-to-session lineage matters to you. Queue
  messages are transient work, not conversation history; provider sessions stay
  on the Mac.
- Azure Storage usage is typically small, but it is your account and billing
  boundary. Configure the budget and monitoring appropriate for your deployment.

## Security notes

- This self-hosted deployment binds each relay token to one Slack tenant and
  one registered device. Multiple workers can coexist; mapped continuations
  remain device-affine while new jobs can lease to any healthy worker.
- Slack requests use Slack’s timestamped `v0` HMAC verification.
- Direct bot tokens and signing secrets stay server-side.
- The desktop backend token stays in Keychain.
- Azure credentials stay in the backend environment.
- Allowlist Slack users explicitly; do not expose a public unrestricted bot.
- Slack bot tokens remain server-side. Workers fetch only attachment bytes that
  belong to their claimed job through the authenticated relay.
- Incoming files are streamed through the backend, bounded to 100 MB each and
  200 MB per job, staged with owner-only permissions under Mako's data
  directory, and removed when the run settles. The backend does not hold a
  100 MB attachment buffer.
- Outgoing files stream from the workspace through the backend, are limited to
  five files at 25 MB each, and must resolve inside
  the active workspace; symlinks cannot escape that boundary.
- Local browser and computer tools remain local and are not provided by the
  backend.
