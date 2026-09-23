# Local Control acceptance on disposable Linux machines

The native x64 acceptance suite can run on GitHub-hosted Ubuntu, an x86-64 EC2
instance, or another disposable Linux VM with Docker and Node 24. It does not
need an agent provider key or a logged-in browser. The fixtures create their
own GTK applications, X server and D-Bus session.

The public-repository workflow is
[`local-control-linux-x64.yml`](../.github/workflows/local-control-linux-x64.yml).
It runs for relevant pull requests and manual dispatches once the workflow is
published. Contributors do not need AWS or Vercel accounts.

Native Intel Xeon acceptance passed on a disposable EC2 VM on 2026-09-23.
The GitHub workflow is prepared locally; that is not a published workflow run.
The [runtime design](local-control-runtime.md) distinguishes this test package
from the remaining standalone cloud-service launcher.

## What a pass establishes

- Exact values, complete/capped reads, strict locators and thirty save jobs.
- Concurrent synthetic typing into a second app, plus stale-target and modal
  refusal checks.
- Native gestures, recorded cursor paths, covered-window recording and retained
  playable video after interruption.
- Native x64 execution, checked against the host's CPU/vendor and Docker
  architecture before tests start. The evidence records the driver and payload
  hashes. ARM translation does not pass this runner's preflight.

This does not establish physical keyboard/IME behavior on macOS, real GPU/display
hardware, or all Wayland compositor routes. A cloud Linux run cannot replace the
Mac fixture's requirement for a person using an actual input method.

## Contributor workflow boundaries

The workflow uses ordinary `pull_request` and `workflow_dispatch` events and a
fresh GitHub-hosted VM. It has `contents: read`, no cloud/provider secrets, no
OIDC permission and no GitHub environment. Checkout credentials are not persisted.
Actions are pinned to full commit SHAs; dependency caching is disabled for this
job. There is no `pull_request_target`, privileged follow-up workflow, self-hosted
runner, or promotion of test artifacts into a release.

Build and dependency installation have internet access. Actual desktop tests run
in containers with `--network none`, without a Docker socket, host display,
private network mount or cloud credentials. The container receives only the
prepared payload and an output directory, and runs as the calling user so
recordings remain collectible without root. Each run requires a new evidence
directory. The outer disposable VM is the
isolation boundary for untrusted builds; Docker alone is not a promise that an
arbitrary pull request is safe on a developer's daily-use machine.

Artifacts contain synthetic fixture data, logs, CPU metadata and recordings.
They expire after fourteen days and exclude hidden files. Treat artifacts from
unreviewed contributions as untrusted data. Never execute them in a privileged
release job. Keep screenshots and recordings confined to these synthetic apps;
do not add real accounts, sessions, profiles, tokens or personal documents to
acceptance fixtures.

These choices follow [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).
Repository owners should retain approval requirements for outside contributors
and avoid granting write tokens or secrets to fork workflows. Branch/release
protection and workflow review remain repository administration responsibilities.

## Run the same suite elsewhere

Build the shared host and a reviewed x64 driver package as described in
[`scripts/linux-control/README.md`](../scripts/linux-control/README.md). From the
repository root, create a new payload directory:

```sh
node scripts/linux-control/prepare-acceptance.mjs \
  release/control-driver/0.28.2+mako.17/linux-x64 \
  release/local-control-acceptance
```

The preparer copies the actual compiled host modules required by the control
entry point, the control package including its worker, explicit fixtures, the
locked npm runtime dependencies, and the driver/license/provenance. It verifies
the binary hash and reviewed patch. It rejects symlinks in selected files,
machine-specific lockfile paths, private registry URLs and pre-existing output
directories. It copies ordinary file bytes and permission bits, not extended
attributes or setuid metadata. It does not copy `.git`, `.env`, local
`node_modules`, provider sessions or cloud CLI configuration.

Review `payload.json`, then transfer only that directory to the disposable VM.
Do not upload a tarball of the whole checkout or forward your shell environment.
From the transferred payload root:

```sh
sh scripts/linux-control/run-acceptance.sh
```

The runner verifies CPU and payload hashes, installs dependencies with the
committed lockfile and lifecycle scripts disabled, and builds a runtime-only
image without Rust or Chromium. Docker receives only the Dockerfile as its build
context. Both suites run even if one fails; the runner collects diagnostics and
removes its named containers on exit. Copy back `evidence/`, then destroy the VM.
Payloads under `release/` are already gitignored. Do not commit recordings,
generated executables or machine-specific cloud state.

Run `node scripts/linux-control/test-acceptance-payload.mjs` to verify packaging
boundaries. It checks excluded credential canaries, worker retention, package
hashes, unsafe symlinks, escaped lockfile paths and overwrite refusal. The
allowlist does not replace reviewing the source being compiled for hard-coded
secrets.

## Optional cloud backends

**EC2:** use a disposable x86-64 instance in an isolated test VPC, with no IAM
instance profile, encrypted storage deleted on termination, no public app ports,
and SSH restricted to the operator's address. Cloud-init may need IMDSv2 during
bootstrap to obtain the SSH key and user data; disable the metadata endpoint and
verify the setting is applied **before** transferring or executing test code.
Keep AWS credentials on the operator's machine. Bound the lifetime and terminate
the instance, key pair and temporary network after collecting evidence. A test
instance should not share a production VPC or act as a persistent public-PR
runner. See [EC2 metadata configuration](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-IMDS-new-instances.html).

**Vercel Sandbox:** supports Docker inside its own microVM. Use an operator's
authenticated CLI outside the sandbox, a non-persistent sandbox with a bounded
timeout and no published ports, then transfer only the prepared payload. Confirm
CPU architecture with the same runner; provider branding alone is not native
x64 evidence. Do not pass Vercel tokens as sandbox environment variables or pull
application environment files into it. Remove the sandbox after downloading
evidence. This backend is optional and has not passed Mako acceptance yet.
See [Sandbox isolation and Docker](https://vercel.com/docs/sandbox/concepts/runtimes)
and the [Sandbox CLI](https://vercel.com/docs/sandbox/cli-reference).
