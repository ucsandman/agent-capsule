# agent-capsule

Pack a Claude Code user harness (`~/.claude`) into a portable tarball and
apply it elsewhere. Zero deps: Node 20+ builtins + system `tar`.
```
node capsule.mjs pack [--out DIR]                          # default: ./dist
node capsule.mjs apply CAPSULE.tgz [--home DIR] [--dry-run]
node capsule.mjs doctor [--home DIR]    # dry-executes every hook, never mutates
node capsule.mjs provision [--home DIR] [--apt] [--dry-run]   # on the box, after apply
node capsule.mjs secrets list [--stage DIR]                   # names only, never values
node capsule.mjs secrets push DEVBOX [NAME...]                # local -> devbox
node capsule.mjs release [--out DIR] [--dry-run]              # pack + gh release create
```
`pack` writes `DIR/capsule.tgz` + `DIR/manifest.json`. `apply` backs up any
existing `.claude` to `.claude.pre-capsule-<timestamp>`, extracts, rewrites
the `__CAPSULE_HOME__` token to the real home, and checks every required
interpreter/binary is on `PATH`.

**Excluded:** `projects/` (only `*/memory/`), `plugins/` (top-level config
only), caches/logs/session state, `history.jsonl`, `node_modules`,
`*.bak*`, files over 2MB, secret-name patterns (`.env*`, `keys/`, `creds*`,
`*token*`, `*.pem`, `*.key`), plus anything in `extraExclusions`. Every staged
text file is secret-scanned before tarring; any hit deletes the stage and exits
2 — nothing is ever tarred.

## Configuration

Machine-specific values live in `capsule.config.json`, never in the code. Lookup
order: `--config PATH` → `$CAPSULE_CONFIG` → `capsule.config.json` beside
`capsule.mjs` → built-in generic defaults (every key empty or null).

| key | meaning |
| --- | --- |
| `externalRoot` | root of the checkouts hooks may reference (`C:/Projects`). Hook files under it are staged into `ext/<repo>/` and rewritten. `null` disables external refs entirely. |
| `localPyPackages` | `python3 -m <module>` hooks with no PyPI package, mapped to a local source tree. A leading `~/` in `src` expands to the home dir. |
| `extraExclusions` | extra file and directory names to skip, on top of the built-in secret/junk list. Case-insensitive. |
| `release.repo` | the repo `capsule release` publishes to. `$CAPSULE_REPO` overrides it. |
| `secrets.defaultPrefixes` | the name prefixes `secrets push` sends when you name none. Empty means you must name them explicitly. |

A malformed config or an unknown key exits 1 with one line. A missing file is not
an error: you get the generic defaults, which pack a harness with no external
repos and no local python packages.

## Tests

`npm test` — Node's built-in runner, still zero dependencies. CI runs it on
ubuntu-latest and windows-latest (node 22) along with `node --check capsule.mjs`.
The suite builds a fake home under the OS temp dir and packs it with
`pack --home DIR`, so it never reads the real `~/.claude`.

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

## provision — install what the hooks need

`pack` writes a `provision` block into `manifest.json` from a static table keyed
by hook binary, plus a detector for `python3 -m <module>` hooks. A module with no
PyPI package (listed in `localPyPackages`) is staged from its local source tree into
`ext/pypkg/<name>/` (`src`, `pyproject.toml`, `README.md`, `LICENSE`; no
`__pycache__`, no `.egg-info`) and installed editable on the box.

```
{ "pip": ["repowise"], "pip_local": ["ext/pypkg/context-handoff-bundle"],
  "cargo": [], "apt": ["powershell"],
  "github": [{ "repo": "rtk-ai/rtk", "asset": "rtk-x86_64-unknown-linux-musl.tar.gz", "bin": "rtk" }] }
```

`provision` reads that block from `~/.claude/.capsule-manifest.json`, skips any
step whose target already resolves (so re-runs are cheap), logs each command with
its exit code and first stderr line, never aborts on one failure, and finishes by
re-running the doctor to print pass counts before vs after. `apt` needs `--apt`
(sudo). Install chain for Python: `pip --user` → `uv pip --system` →
`pip --user --break-system-packages`; the last rung is what works on a uv-managed
PEP 668 interpreter and writes only to the user site dir.

Verified 2026-09-03 on Namespace devbox Subscription-X-Ray (Ubuntu, node 22,
uv-managed python 3.14): **doctor 31/38 → 36/38**. `repowise-rewrite` and the
three `context_handoff_bundle` hooks fixed; `rtk` installed from its GitHub
release. `cargo install rtk` is the **wrong** crate (a "Rust Type Kit", v0.1.0) —
the table uses the `rtk-ai/rtk` musl release, whose `--help` says "filter and
summarize system outputs". The two `pwsh` hooks still fail: the manifest keeps
`apt: ["powershell"]`, but `apt-get install powershell` exits 100 ("Unable to
locate package") on the stock Ubuntu repos — PowerShell needs the Microsoft apt
repo added first, which `provision` does not do. Treat that step as unsupported
until someone adds the repo.

`~/.local/bin` must be on `PATH` for the doctor to see pip/cargo scripts;
`provision` prepends it and prints a hint if the login shell lacks it.

## secrets

`secrets list` scans the packed capsule's own hooks (`process.env.X`,
`os.environ[...]`, `os.getenv(...)`) plus `settings.json` `env` keys, so the name
list comes from the capsule rather than a hardcoded list, and prints
`detected=N set=M`. Values are never printed, logged, or read from any
`.env`/secrets file — only `process.env` is consulted.

`secrets push` writes `export NAME='value'` lines (single-quote escaped) to a
mode-0600 temp file, uploads it, moves it to `~/.claude/load-secrets.sh` with
`chmod 600`, syntax-checks it with `bash -n` (it is sourced by every hook through
`env.BASH_ENV`, so a syntax error would break them all), then deletes the local
temp file in a `finally`. Set `CAPSULE_SCRATCH` to control the temp directory.

The default push scope is the `secrets.defaultPrefixes` slice of the detected set
(`DASHCLAW_*` here). The scan also finds unrelated live keys (Stripe, GitHub,
Resend, Vercel); those are pushed only if you name them explicitly. With no
prefixes configured, `secrets push` refuses to guess and asks you to name them.

The scan root defaults to `./dist/stage` when you are in the repo, else
`~/.claude`. A bare `~/.claude` has no `ext/`, so run `secrets` from the repo
after `pack`, or pass `--stage DIR`, or you will detect a smaller name set.

`apply` keeps an existing `load-secrets.sh` (it is never packed, and a missing
`BASH_ENV` target fails silently), so re-applying a capsule does not
unauthenticate the hooks.

```
node capsule.mjs secrets push Subscription-X-Ray
node capsule.mjs secrets push Subscription-X-Ray DASHCLAW_API_KEY DASHCLAW_URL
```

## A new devbox, end to end

**Precondition:** `install.sh` needs a `capsule.tgz` from somewhere. A private
release exists (first one: `capsule-20260903-0600`); refresh it with
`node capsule.mjs release`. Without a release, `CAPSULE_URL`, or a hand upload
the script exits 1 by design. The release-download rung was verified 2026-09-03
on Subscription-X-Ray (`gh repo clone` + `install.sh` -> downloaded, doctor
36/38). A from-scratch `devbox create --dotfiles ...` could not be verified that
day: every `devbox create` (any flags) failed server-side with
`SQLSTATE 40001 could not serialize access`; retry from the CLI or the web UI.

```
node capsule.mjs pack --out dist
devbox create my-box --dotfiles https://github.com/ucsandman/agent-capsule --setup_github
devbox upload my-box --mkdir dist/capsule.tgz    capsule/capsule.tgz
devbox upload my-box --mkdir capsule.mjs         capsule/capsule.mjs
devbox upload my-box --mkdir bootstrap/install.sh capsule/install.sh
devbox exec my-box -- bash -c 'mkdir -p ~/capsule/bootstrap && mv /workspaces/*/capsule/capsule.* ~/capsule/ && mv /workspaces/*/capsule/install.sh ~/capsule/bootstrap/ && bash ~/capsule/bootstrap/install.sh'
node capsule.mjs secrets push my-box
```

Once a release exists, the whole middle collapses to running
`bootstrap/install.sh` from the dotfiles checkout — it pulls both assets with
`gh release download` (which is why `--setup_github` matters). `devbox --dotfiles`
does not document where it clones, so invoke the script by its actual path on the
box rather than assuming one.

`bootstrap/install.sh` is idempotent. It sources `capsule.tgz` + `capsule.mjs`
in this order: already in `~/capsule` → `gh release download --repo <repo>` →
`$CAPSULE_URL` → the dotfiles checkout next to the script. `<repo>` is
`$CAPSULE_REPO`, else `release.repo` read out of `../capsule.config.json` with
`node -p`; with neither, the release rung is skipped with a message rather than
failing. It skips `apply` when `~/.claude/.capsule-manifest.json` already exists
(`CAPSULE_FORCE=1` overrides), runs `provision`, and prints the doctor summary.
`provision` and `doctor` are guarded so a failing optional hook cannot fail the
bootstrap. Env knobs: `CAPSULE_REPO`, `CAPSULE_DEST`, `CAPSULE_URL`,
`CAPSULE_APT`, `CAPSULE_FORCE`.

`capsule release` packs, then `gh release create capsule-<yyyymmdd-HHMM>
dist/capsule.tgz capsule.mjs --repo ucsandman/agent-capsule-store` (the store
repo from `release.repo`; `$CAPSULE_REPO` overrides it, and with neither set the
command exits 1 before packing). The repo is private, so the asset stays private
and `gh release download` on the box needs `--setup_github`. Use `--dry-run` to
print the exact `gh` command without publishing.
