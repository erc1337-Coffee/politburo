---
"@vercel/board": minor
---

**Breaking:** In 0.54.0, an OIDC grant's `sub` is a prefix match when its
only `*` is last, right after a `:` or `/` with a character before the
separator. `project_path:acme/api:*` matches `project_path:acme/api:ref:main`.
Other stored `sub` values, including a bare `*` or a star elsewhere, match
exactly. Grants stay as written. A stored literal in prefix form now matches
every subject that starts with the text before `*`, if the issuer and the
other claims match.

Audit stored subjects **before upgrading** an existing board that stores and
decides its grants locally. Set `BOARD_URL` to its API URL and run
`vb grants list --json` with `manage` at `*`. For each grant's `principals`
with `kind: 'oidc'`, check every `claims.sub` value ending in `*`, whether
stored as a string or in an array. Keep intended prefixes that follow the
rule. For a literal, use `vb grants update` with `--remove-oidc` and
`--add-oidc` to replace it with an exact subject or tighten the grant before
upgrading. Vercel's API decides its own grants. Its operators choose whether
to audit them with Vercel's own tooling.
