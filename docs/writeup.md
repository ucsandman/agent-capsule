# Moving my Claude Code harness onto a throwaway Linux box

My Claude Code setup on Windows is heavy. 38 hooks, a pile of skills, agent
definitions, a memory store, and some hooks that live in other repos on the
same disk. I wanted all of that on a cloud Linux devbox so I could throw long
jobs, sketchy installs and clean-clone checks at it without touching the
machine I actually work on. Here's what it took and what I'd tell you before
you try the same thing.

## Why you can't just copy `~/.claude`

It looks portable. It isn't.

- **The paths are baked in.** `settings.json` names every hook by absolute
  Windows path. Hooks reference each other the same way. Some of them run
  files out of `C:/Projects/<repo>/`, which isn't even in the folder.
- **Interpreters don't match.** Hooks say `py -3.12` or `python`. Linux
  wants `python3`.
- **It's full of junk you don't want.** Session transcripts, caches, shell
  snapshots, `history.jsonl`, a credentials file, and whatever your hooks
  dropped in `keys/` or `.env`.
- **It's missing stuff you do need.** Binaries like `rtk` or a pip package a
  hook shells out to are installed on the source machine and written down
  nowhere.
- **Secrets.** Hooks auth to services with env vars. Those can't ride in a
  tarball that might ever end up on GitHub.

## What the tool does

`capsule pack` walks a whitelist of `~/.claude` (hooks, skills, agents,
commands, memory, project memories, top-level config) into a staging dir. It
skips caches, session state, anything named like a secret, and anything over
2MB. It reads `settings.json`, follows every external hook reference into its
repo and copies the file plus whatever it imports. Then it rewrites every
form of the home path it can find (`C:\Users\me`, `C:/Users/me`, the
JSON-escaped double backslash version, the git-bash `/c/Users/me` version)
to one token, `__CAPSULE_HOME__`, and fixes the interpreters. A manifest
records every hook before and after, which binaries it needs, and how to
install each one. Last step is a secret scan over every staged text file.
One hit deletes the stage and exits 2. Nothing gets tarred.

`capsule apply` on the box extracts, swaps the token for the real home, and
keeps the box's own credentials, sessions and secrets file. `capsule
provision` installs what the manifest says is missing. `capsule doctor` runs
every hook once and tells you what passed, as text and as an HTML page.
`capsule secrets push` sends the env vars the hooks actually read, as a
0600 file the hooks source through `BASH_ENV`, never inside the tarball.
`capsule deploy` does the upload and bootstrap in one shot, to a Namespace
devbox or any host over plain ssh.

Zero deps. One Node file and the system `tar`.

## Results

| | |
|---|---|
| files packed | about 2,000 |
| tarball | 4.6 MB |
| hooks after apply | 31 of 38 pass |
| hooks after provision | 36 of 38 pass |
| with `--apt` (sudo) | 38 of 38 pass |

The last two are PowerShell hooks. Stock Ubuntu has no `powershell` package,
so the apt step registers the Microsoft repo first. That one needs sudo, which
is why it's behind a flag.

A headless Claude Code run on the box came back with my output style, my
guard hooks and my skills all live.

## Things that bit me

This is where the time went, not the packing logic.

- **`cargo install rtk` installs the wrong thing.** That crate is an
  unrelated "Rust Type Kit". The real `rtk` is a musl binary on its GitHub
  releases page, so that's where provision pulls it from now.
- **The devbox Python is uv-managed.** PEP 668 makes `pip install --user`
  refuse, and `uv pip install --system` hits the wrong interpreter. What
  works is `pip install --user --break-system-packages`, which despite the
  scary name only writes to the user site dir. Provision tries all three in
  order.
- **A missing `BASH_ENV` file fails silently.** If the secrets file isn't
  there, every hook runs unauthenticated and the doctor still says pass,
  because the hooks exit 0 on a missing key. So `apply` never deletes an
  existing secrets file, and `secrets push` only swaps it in after the
  transfer succeeds.
- **git-bash mangles remote paths.** Hand the devbox CLI an absolute
  `/home/...` path from a Windows shell and MSYS turns it into
  `C:/Program Files/Git/home/...`. Uploads go workspace-relative and get
  moved into place by a second command.
- **`gh release create` on Windows splits your title on spaces** if you go
  through a shell. Spawn it without one.
- **The release asset is your entire harness.** Memory files included. Cut
  releases in the repo you later flip public and they go public with it.
  Releases live in a separate private repo now.
- **`--force-local` is GNU tar only.** Windows ships bsdtar, which rejects
  it. Check which tar you've got.

## What this isn't

The copy-a-folder part is a commodity. There are at least seven open source
dotfile syncers, and Anthropic has an open request for account-level
settings sync that would make that layer disappear. The part that isn't a
commodity is the rest: pulling in out-of-tree hook sources, translating paths
and interpreters across operating systems, writing down how to install the
binaries the hooks need, and keeping secrets out of the artifact while still
getting them to the box.

A team version, shared harness, per-person scoped secrets, an audit trail of
what ran where, is a different product with a different buyer. This repo
stays a single-user tool under MIT.

## Try it

```
git clone https://github.com/<you>/agent-capsule
cd agent-capsule
node capsule.mjs pack
node capsule.mjs deploy ssh:you@your-box --force
node capsule.mjs secrets push ssh:you@your-box
```

Then open `~/capsule/doctor.html` on the box and see what passed.
