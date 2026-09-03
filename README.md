# agent-capsule

Move a whole Claude Code user harness onto a fresh Linux box: `~/.claude` with
its hooks, skills, agents, commands, memory, and the out-of-tree repos its hooks
call into. Secrets never ride inside the tarball: they go over separately
as a mode-0600 `load-secrets.sh`, and every staged text file is secret-scanned
first, so a stray key deletes the stage instead of shipping.

Zero deps: Node 20+ builtins + system `tar`.
```
node capsule.mjs pack [--out DIR]                              # default: ./dist
node capsule.mjs apply CAPSULE.tgz [--home DIR] [--dry-run]
node capsule.mjs doctor [--home DIR] [--html FILE]   # runs every hook, changes nothing itself
node capsule.mjs provision [--home DIR] [--apt] [--dry-run]    # on the box, after apply
node capsule.mjs deploy TARGET [--out DIR] [--force] [--dry-run]   # upload + bootstrap
node capsule.mjs secrets list [--stage DIR]                    # names only, never values
node capsule.mjs secrets push TARGET [NAME...]                 # local -> box
node capsule.mjs release [--out DIR] [--dry-run]               # pack + gh release create
```
`pack` writes `DIR/capsule.tgz` + `DIR/manifest.json`. `apply` backs up any
existing `.claude` to `.claude.pre-capsule-<timestamp>`, extracts, rewrites
the `__CAPSULE_HOME__` token to the real home, and checks every required
interpreter/binary is on `PATH`.

**Excluded:** `projects/` (only `*/memory/`), `plugins/` (top-level config
only), caches/logs/session state, `history.jsonl`, `node_modules`, `*.bak*`,
files over 2MB, and secret-name patterns: `.env*`, `keys/`, `*.pem` and `*.key`
always; `*token*`, `*credential*` and `*creds*` on non-code files only, so a
hook named `token-guard.cjs` is still packed. Plus anything in `extraExclusions`.
Every staged text file is secret-scanned before tarring; any hit deletes the
stage and exits 2. Nothing is ever tarred.

## Targets

`deploy` and `secrets push` take a TARGET in one of two forms:

| TARGET | transport |
| --- | --- |
| `my-box` | a [Namespace](https://namespace.so) devbox, driven through the `devbox` CLI |
| `ssh:HOST` | plain `ssh`/`scp`; HOST is whatever your ssh accepts, `user@host` or an ssh-config alias |

Neither spawns a local shell, so nothing is re-split on the way out. (`ssh` does
hand its argv to the *remote* login shell, so commands are single-quoted for
exactly one round-trip before `bash -c` sees them.) `--dry-run` prints the exact
argv of every command and spawns nothing.

`deploy` uploads `capsule.tgz`, `capsule.mjs` and `bootstrap/install.sh` to
`~/capsule/` on the box and then runs the installer there, exiting with its
status. `--force` sets `CAPSULE_FORCE=1` so an already-applied harness is
re-applied; `CAPSULE_REPO` (or `release.repo` from the config) is passed through
so the installer can fall back to a release download.

```
node capsule.mjs deploy my-box --force
node capsule.mjs deploy ssh:alice@vps --out dist
```

Devbox notes: install the CLI with `irm https://get.namespace.so/devbox/install.ps1 | iex`,
then `devbox login`. Remote paths given to `devbox upload` are relative to the
workspace dir, and an absolute `/home/...` path gets mangled by git-bash into
`C:/Program Files/Git/home/...`, which is why every upload lands in
`capsule/` and is moved into place by a following `devbox exec`. Claude Code on
a devbox lives at `~/.local/node_modules/.bin/claude` (not on `PATH` in `exec`).

SSH notes: some `scp` builds read `C:/x/y` as a host named `C`, so the transport
runs `scp` from the file's own directory and passes `./<name>`, a form no `scp`
can take for a host. Destinations are relative to the remote `$HOME`.

`apply` keeps the target's own `.credentials.json`, sessions, projects and
plugins, so Claude Code stays logged in.

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

`npm test` runs Node's built-in runner, still zero dependencies. CI runs it on
ubuntu-latest and windows-latest (node 22) along with `node --check capsule.mjs`.
The suite builds a fake home under the OS temp dir and packs it with
`pack --home DIR`, so it never reads the real `~/.claude`.

## provision: install what the hooks need

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

Verified on a Namespace devbox (Ubuntu, node 22, uv-managed python 3.14): doctor
31/38 before provision, 36/38 after.

Two known gaps. `cargo install rtk` is the **wrong** crate (a "Rust Type Kit",
v0.1.0), so the table pulls `rtk` from the `rtk-ai/rtk` musl release instead,
whose `--help` says "filter and summarize system outputs". And the two `pwsh`
hooks still fail: the manifest keeps `apt: ["powershell"]`, but
`apt-get install powershell` exits 100 ("Unable to locate package") on the stock
Ubuntu repos. PowerShell needs the Microsoft apt repo added first, which
`provision` does not do. Treat that step as unsupported until someone adds the repo.

`~/.local/bin` must be on `PATH` for the doctor to see pip/cargo scripts;
`provision` prepends it and prints a hint if the login shell lacks it.

## doctor

`doctor` runs every configured hook for real, with a synthetic `SessionStart`
payload and no tool call attached, and prints one row per hook: event, command,
exit code, first stderr line. It changes nothing itself, but a hook that writes
on `SessionStart` will still write. Exit 0 and exit 2 both count as a pass: 2 is
a guard deliberately blocking, which means the hook works.

`--html FILE` writes the same rows as a self-contained page: a
`N/M hooks pass` badge (green at full marks, amber otherwise), the target home,
the timestamp, and a pass/fail-tinted table. No scripts, no external assets,
light and dark via `prefers-color-scheme`. `bootstrap/install.sh` writes one to
`$DEST/doctor.html` on every run, so the end of a bootstrap leaves a page you can
open rather than a log you have to read.

Both the page and `doctor.log` keep each hook's first stderr line at the default
umask, so a hook that prints a value when it fails puts that value in a file that
survives. Treat `$DEST` as you would any other log directory.

## secrets

`secrets list` scans the packed capsule's own hooks (`process.env.X`,
`os.environ[...]`, `os.getenv(...)`) plus `settings.json` `env` keys, so the name
list comes from the capsule rather than a hardcoded list, and prints
`detected=N set=M`. Values are never printed, logged, or read from any
`.env`/secrets file. Only `process.env` is consulted.

`secrets push` writes `export NAME='value'` lines (single-quote escaped) to a
mode-0600 temp file, uploads it to a staging path and moves it onto
`~/.claude/load-secrets.sh` at mode 600 (over ssh the staging file is pre-created
0600 before any bytes land; on a devbox it briefly sits in the workspace dir at
whatever mode `devbox upload` gives it), syntax-checks it with `bash -n`
(it is sourced by every hook through `env.BASH_ENV`, so a syntax error would
break them all), removes the remote file if any step fails, and deletes the local
temp file in a `finally`. Set `CAPSULE_SCRATCH` to control the temp directory.
`--dry-run` prints the argv and writes no temp file at all.

The default push scope is the `secrets.defaultPrefixes` slice of the detected set.
The scan also finds unrelated live keys (Stripe, GitHub, Resend, Vercel); those
are pushed only if you name them explicitly. With no prefixes configured,
`secrets push` refuses to guess and asks you to name them.

The scan root defaults to `./dist/stage` when you are in the repo, else
`~/.claude`. A bare `~/.claude` has no `ext/`, so run `secrets` from the repo
after `pack`, or pass `--stage DIR`, or you will detect a smaller name set.

`apply` keeps an existing `load-secrets.sh` (it is never packed, and a missing
`BASH_ENV` target fails **silently**, leaving every hook unauthenticated with no
doctor failure), so re-applying a capsule does not unauthenticate the hooks.

```
node capsule.mjs secrets push my-box
node capsule.mjs secrets push ssh:alice@vps API_KEY API_URL
```

## A new box, end to end

```
node capsule.mjs pack --out dist
node capsule.mjs deploy my-box --force
node capsule.mjs secrets push my-box
```

`deploy` works against any target, including `ssh:user@host`. For a Namespace
devbox created from dotfiles, Namespace runs the checkout's `install.sh` for you:

```
devbox create my-box --dotfiles https://github.com/<you>/agent-capsule --setup_github
```

`devbox --dotfiles` does not document where it clones, so invoke the script by its
actual path on the box rather than assuming one.

`bootstrap/install.sh` is idempotent. It sources `capsule.tgz` + `capsule.mjs`
in this order: already in `$DEST` → `gh release download --repo <repo>` →
`$CAPSULE_URL` → the dotfiles checkout next to the script (which supplies
`capsule.mjs` only, never the tarball). `<repo>` is
`$CAPSULE_REPO`, else `release.repo` read out of `../capsule.config.json` with
`node -p`; with neither, the release rung is skipped with a message rather than
failing. Without a `capsule.tgz` from any of those sources the script exits 1 by
design. It skips `apply` when `~/.claude/.capsule-manifest.json` already exists
(`CAPSULE_FORCE=1` overrides), runs `provision`, then `doctor --html`. `provision`
and `doctor` are guarded so a failing optional hook cannot fail the bootstrap.
Env knobs: `CAPSULE_REPO`, `CAPSULE_DEST`, `CAPSULE_URL`, `CAPSULE_APT`,
`CAPSULE_FORCE`.

`capsule release` packs, then runs `gh release create capsule-<yyyymmdd-HHMM>
dist/capsule.tgz capsule.mjs --repo <release.repo>` (`capsule.config.json` ships
an example value; `$CAPSULE_REPO` overrides it, and with neither set the command
exits 1 before packing). Point it at a **private** repo: the asset is your whole
harness. `gh release download` on the box then needs `--setup_github`. Use
`--dry-run` to print the exact `gh` command without publishing.

## License

MIT.
