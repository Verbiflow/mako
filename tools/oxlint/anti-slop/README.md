# Reviewed raw-data decoding

The two rules `no-unknown-parameters` and `no-runtime-typeof` default to their
existing strict policy. `oxlint.config.ts` explicitly lists one reviewed
prevalidation boundary: the canonical protocol module's exported
`plainProtocolValue`, returning the named `PlainProtocolValue` contract.

The shared AST predicate accepts only its single raw `input` parameter and
its direct lexical, recursive `const copy(value, depth)` arrow's raw `value`
parameter. That helper must return the same named contract. Only its existing
strict primitive, container, array-length and own-key classifications qualify.
Nested callbacks, sibling/moved helpers, method signatures and unknown returns
receive no inherited exception. The literal `cause` parameter and optional
type-guard policy retain their previous behavior.

This is a reviewed lint boundary allowlist. It does not authenticate input,
prove decoder safety, authorize a repository or grant runtime authority.
Changes to the decoder still require security review and adversarial tests.
`npm run test:lint-rules` exercises real oxlint AST and scope analysis; normal
`lint:anti-slop` also runs the boundary regression tests before checking source.
