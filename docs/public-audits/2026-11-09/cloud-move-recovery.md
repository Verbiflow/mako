# Recovering a failed move to the cloud

This repair keeps a confirmed failed move visible above the desktop composer,
with the owner's reason, its local location, and explicit Retry and Dismiss
actions. A transport error instead says the move is unconfirmed. Its status
check uses the original move ID; it does not create a second move. A deliberate
retry after a confirmed refusal gets a new ID and retains handoff intent.

This is a first repair to the desktop recovery journey, not acceptance of the
cloud service as usable end to end. It changes renderer state and components,
plus the existing credential-free move UI test. It changes no host move,
authentication, repository-authority, provisioning, broker, or backend contract.

## Failure and cause

The source baseline is main `40b88bca2fd6629b144a16bcb89fbb944e795a12`.
`threadMoveStepped` removed the move from renderer state on `kept-here`,
leaving its reason only in a temporary toast. The existing UI test explicitly
expected the composer notice to disappear. An early RPC refusal without a
corresponding event was also ignored, leaving the initial packing state.
Exceptions were classified as `kept-here`, although losing a reply cannot
establish which machine owns the Thread.

That combination is a major recovery defect: after preparation fails, the
person loses the reason and next action; after a lost answer, the UI can imply
that the Thread stayed local without evidence. The reported five failed real
handoffs motivated this investigation, but were not repeated here. Their
private secondary-repository clone failure and exact authorization cause
remain the backend workstream's responsibility.

The repair keeps confirmed failures separately from active moves, so their
location chip returns to Local. They survive component updates and theme
changes until dismissed or a new move starts. They are held in this window's
memory, not durable across an app restart. Full error text and the instruction
to keep the Mac awake remain available from the notice's detail button.

An unconfirmed move keeps the original operation and disables starting a
different move from its chip. The chip stops spinning and says “Move not
confirmed.” Check status rejoins the original request. Only the owner's
existing `moved` event changes the location to Cloud; acceptance, release,
packing, and hand-over remain preparation or unresolved ownership states.

## The first journey and its remaining gates

| Journey point | Evidence in this repair | Remaining acceptance |
| --- | --- | --- |
| Choose Cloud and prerequisites | Existing Local-chip offer and harness checks run in the fixture suite. | Real account eligibility, all repository permissions, and destination prerequisites must be established by their owners. |
| Provision and prepare code | A returned refusal without an event retains its actual reason and offers recovery. | Private multi-repository cloning, the serving image, readiness, and retained authorization diagnostics need real backend acceptance. |
| Carry the session and running turn | Retry preserves handoff intent, including repeated refusal events. Existing preparation, pause, hand-over, resume and moved UI cases still run. | An actual destination must claim ownership and continue the same work; an accepted command or `released` response is insufficient. |
| Use tools and apps there | No new capability claim. | Tools, app ports, previews and repository/worktree contents need verification on that same destination. |
| Disconnect or close the lid | Lost replies stay unconfirmed and can be checked under the same ID; no shutdown clearance is given. | Actual continuation through disconnect/sleep and recovery remains untested. |
| Return and recover | Existing fixture return, version mismatch, missing project, unsettled return and merge cases remain in the suite. | Real return must preserve work and ownership, including restart recovery. |
| Cleanup and cost | Dismiss removes only the local failure notice; it neither starts nor cancels a cloud operation. | Actual machine cleanup and cost visibility are not proved by a local refusal and require separate runtime evidence. |

The backend authority/coordinator/security workstream, move diagnostics work,
and crew-card work are not modified by this branch. No permission is inferred
from a message saying that a move was accepted.

## What the comparison sources actually say

Capy's current documentation separates choosing the machine and checkout from
moving existing work. Its cloud move requires GitHub App access to every
repository and available credits; the project environment is prepared before
restoring work. It also names what does not move, including running dev
servers. Those are useful prerequisite and expectation boundaries, not proof
that Mako already has them. [Capy desktop and devices](https://docs.capy.ai/desktop).

T3 Code's remote-access guide requires the execution host to remain running
and reachable; a saved sign-in alone does not make it available. Its remote
architecture keeps execution and durable state with the environment, while
connection routes are separate. A reachable route or a saved connection is
therefore a different fact from where a Thread executes. These are current
documentation comparisons, not measured runtime parity.
[T3 remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md),
[T3 remote architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md).

## Review evidence

The screenshots use fake projects, repositories and sessions from the existing
isolated mock bridge. No actual cloud machine, provider, account sign-in,
grant, token, keychain, native session store, paid compute, install, or release
was used. The test drives the production components with trusted input; it
does not prove any real remote continuation.

Before, the refusal has no standing composer notice once its toast goes:

![Baseline: local composer with no retained move failure](cloud-move-recovery/before.png)

After, a confirmed refusal retains its reason and explicit retry:

![Confirmed refusal remains above the composer](cloud-move-recovery/refused.png)

The detail keeps the full reason and the local-work guidance:

![Full refusal reason and local readiness guidance](cloud-move-recovery/details.png)

A lost reply is distinguished from a confirmed refusal:

![Unconfirmed move offers a status check under its existing ID](cloud-move-recovery/unconfirmed.png)

The extended `test:moves-ui` cases check that a failure remains after the toast
ends; it does not retry automatically; an explicit retry has a new ID; an
early returned private-repository refusal is retained without an event;
dismiss does not make another call; a lost reply is not a local refusal;
Check status keeps its ID; the unconfirmed chip is disabled and does not spin;
and a refused handoff retains its intent after a repeated event and retry.
The rest of the existing move/return suite runs too, in dark and light themes.

Completed locally: package compilation, recipe typecheck and full lint, final
scoped typecheck/ESLint/Oxlint, and the full extended move UI suite. Baseline
and reviewed-run screenshot/state artifacts are included beside this report.
CI for the new PR is a separate result; these checks do not establish installed
or live-cloud success.

Reproduce on a free allocated Thread port:

```sh
MAKO_TEST_EVIDENCE=<private-evidence-folder> npm run test:moves-ui -- --port <port>
```

Build the checkout's packages with `npm run build:control-runtime` first when
their generated output is missing or old. Recipe typecheck and lint cover the
source changes. There is no dependency, recipe, application-entry, or server
start command change.

The baseline suite logged an existing ResizeObserver delivery warning; it is
retained as a limitation rather than reported as a clean console. One new
handoff test initially clicked during a moving composer layout and sent no
retry request, as its call trace showed. It now waits for the fixture's
existing finite animations before clicking. That observation correction does
not stand in for backend readiness or actual shutdown testing.
