# @mako/control

Typed handles, observations and the bounded JavaScript program worker for Mako
Control. Requires Node 24 or newer. Importing this package starts no process and
connects to no application. It has no Electron, MCP or media dependency.

Use `@mako/control-runtime` for a connected session or the `mako-control` CLI.
Adapter authors can bind `controlClient` from `@mako/control/control` to their own
validated transport. `@mako/control/program` owns program state and artifact spill;
`@mako/control/browser` and `@mako/control/computer` contain observations and policy.

Actions return dispatch receipts. Observe or assert the exact target to verify a
result; never retry uncertain input. Element refs and screenshot coordinates belong
to the latest observation of one exact target. Images are explicit. Oversized
results are written whole to artifacts, not silently truncated.

Licensed under Elastic License 2.0; see LICENSE. No registry publication is implied
by this source package.
