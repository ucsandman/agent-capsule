# agent-capsule

Pack a Claude Code user harness (`~/.claude`) into a portable tarball and
apply it elsewhere. Zero deps: Node 20+ builtins + system `tar`.
```
node capsule.mjs pack [--out DIR]                          # default: ./dist
node capsule.mjs apply CAPSULE.tgz [--home DIR] [--dry-run]
node capsule.mjs doctor [--home DIR]    # dry-executes every hook, never mutates
```
`pack` writes `DIR/capsule.tgz` + `DIR/manifest.json`. `apply` backs up any
existing `.claude` to `.claude.pre-capsule-<timestamp>`, extracts, rewrites
the `__CAPSULE_HOME__` token to the real home, and checks every required
interpreter/binary is on `PATH`.

**Excluded:** `projects/` (only `*/memory/`), `plugins/` (top-level config
only), caches/logs/session state, `history.jsonl`, `node_modules`, `tests`,
`*.bak*`, files over 2MB, secret-name patterns (`.env*`, `keys/`, `creds*`,
`*token*`, `*.pem`, `*.key`). Every staged text file is secret-scanned before
tarring; any hit deletes the stage and exits 2 — nothing is ever tarred.

Namespace devbox (verified 2026-09-03 on Subscription-X-Ray; `devbox` CLI from
`irm https://get.namespace.so/devbox/install.ps1 | iex`, then `devbox login`).
Remote paths are relative to the workspace dir; an absolute `/home/...` path
gets mangled by git-bash into `C:/Program Files/Git/home/...`.
```
devbox upload <name> --mkdir dist/capsule.tgz capsule/capsule.tgz
devbox upload <name> --mkdir capsule.mjs      capsule/capsule.mjs
devbox exec <name> -- bash -c 'cd capsule && node capsule.mjs apply capsule.tgz && node capsule.mjs doctor'
```
`apply` keeps the target's own `.credentials.json`, sessions, projects and
plugins, so Claude Code stays logged in. Claude Code on a Namespace devbox
lives at `~/.local/node_modules/.bin/claude` (not on `PATH` in `exec`).
