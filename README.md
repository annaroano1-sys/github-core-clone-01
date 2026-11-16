# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/annaroano1-sys/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/annaroano1-sys/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single dependency-free Node program — built for the
[github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01) on
[make.fun](https://make.fun).

One process serves everything a small GitHub does:

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2 (advertisement,
  `ls-refs`, `fetch` with shallow/deepen, thin-pack, OFS/REF delta reading) and
  receive-pack v0 (push with per-ref fast-forward checks, `non-fast-forward`
  rejections). The pkt-line and packfile codecs are written from scratch — no git
  binary, no dependencies.
- **REST v3** (`/api/v3`): repositories, contents (PUT/DELETE with `sha` + 409 on stale
  writes), labels, issues, pull requests, and squash merges onto the default branch.
- **GraphQL v4** (`/api/graphql`): the documents `gh` and `github-mcp-server` send,
  including introspection for `Issue`, `PullRequest`, `Repository` and `SearchType`,
  cursor pagination, and the `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations — all backed by the same store as REST.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 (with the
  2025-11-25 handshake as a fallback), with six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

## Running it

```sh
node main.ts
```

The process binds an ephemeral port, POSTs `{"port": n}` to `$MAKEFUN_ENV_URL/register`,
then polls `GET $MAKEFUN_ENV_URL/done` until the trial ends and exits 0. Every API
call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; every reply is JSON with a
non-empty `X-GitHub-Request-Id` header.

Deterministic by design: no wall clock and no unseeded randomness anywhere. Every
timestamp comes from `MAKEFUN_TRIAL_NOW`, every id is a counter or a hash, so a replay
of the same requests answers byte-identically.

## Layout

- `main.ts` — the whole forge (single file, standard library only).
- `package.json`, `tsconfig.json` — module and type settings (Node 22+).
