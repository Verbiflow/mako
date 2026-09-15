# Contributing to Mako

Mako is alpha software under active daily development. Issues and pull
requests are welcome; expect the code you touch to have moved by the time a
review lands, and expect reviews to be direct.

## Before you start

Read [AGENTS.md](AGENTS.md). It is the rulebook for the host, the state layer,
the providers and the design system, and a change that contradicts it will be
asked to change. Mako is a provider-neutral meta-harness: no provider gets a
privileged path in public types, bridge names, UI language or session handling.

## Working on a change

```bash
npm install
npm run desktop          # a desktop client against the dev profile's host
npm run lint             # ESLint and Oxlint; both must be clean
npm run typecheck:all
```

Every source change must leave `npm run lint` at zero warnings and zero
errors. Do not disable, downgrade or bypass a rule to make a change pass.
Host handler argument changes need `npm run generate:host-inputs`. Tests for
the layer you touched are named in AGENTS.md beside the behaviour they cover;
run them.

Provider checks create real sessions in your own Claude, Codex, Cursor, Grok,
Devin or OpenCode history. Run them only when you mean to.

## Contribution license

Mako is licensed under the [Elastic License 2.0](LICENSE), a source-available
license, and Verbiflow also offers Mako and its hosted services under
commercial terms. So that Verbiflow can keep distributing Mako that way, and
can relicense it (including to a permissive open-source license) without
tracking down every contributor, every contribution is accepted under the
following grant.

By submitting a contribution (code, documentation, assets or anything else
you intend to be included in Mako) you:

1. confirm that you wrote it, or otherwise have the right to submit it under
   these terms, and that it is not subject to a license that conflicts with
   them;
2. grant Verbiflow a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable copyright license to reproduce, modify, distribute, sublicense
   and otherwise use the contribution as part of Mako or any other work, under
   the Elastic License 2.0, the MIT License or any other license Verbiflow
   chooses; and
3. grant Verbiflow and every recipient of Mako a perpetual, worldwide,
   non-exclusive, royalty-free, irrevocable patent license under any patent
   claims you own that are necessarily infringed by the contribution, alone
   or combined with Mako.

You keep the copyright in your contribution and may use it elsewhere under
any terms you like. If you cannot agree to this grant, or your employer owns
your work and has not approved it, open an issue instead of a pull request.

## Reporting a security problem

Do not open a public issue for a vulnerability. Contact the maintainers
through the repository's security advisory form on GitHub.
