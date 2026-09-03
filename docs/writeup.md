# Moving a Claude Code harness onto a disposable Linux box

I run Claude Code on a Windows desktop with a heavy harness: 38 hooks, a few
dozen skills, agent definitions, a memory store, and hooks that live in other
repos on the same disk. I wanted the same setup on a cloud Linux devbox so I
could hand it long jobs, risky installs and clean-clone checks without touching
the machine I work on. This is what it took, and what I would tell you before
you try it.

## Why copying `~/.claude` does not work

The folder looks portable. It is not.

- **Paths are baked in.** `settings.json` names every hook by absolute path,
  in Windows form. Hooks reference each other the same way. Some of them run
  files from `C:/Projects/<repo>/`, outside the folder entirely.
- **Interpreters differ.** Hooks say `py -3.12` or `python`. Linux has
  `python3`.
- **It is full of state you do not want.** Session transcripts, caches,
  shell snapshots, a `history.jsonl`, a credentials file, and whatever your
  hooks wrote to `keys/` or `.env`.
- **It is missing things you do need.** Hook binaries like `rtk` or a pip
  package the hooks shell out to are installed on the source machine, not
  described anywhere.
- **Secrets.** Hooks authenticate to services with env vars. Those cannot
  ride in a tarball you might ever put on GitHub.

## What the tool does

`capsule pack` walks a whitelist of `~/.claude` (hooks, skills, agents,
commands, memory, project memories, top-level config) into a staging dir,
skipping caches, session state, anything named like a secret, and anything
over 2MB. It reads `settings.json`, follows every external hook reference
into its source repo and copies the file plus the siblings it imports. Then it
rewrites every form of the home path it can find (`C:\Users\me`,
`C:/Users/me`, the JSON-escaped double backslash form, the git-bash
`/c/Users/me` form) to one token, `__CAPSULE_HOME__`, and normalises the
interpreters. A manifest records every hook before and after rewriting, which
binaries they need, and how to install each one. Last, every staged text file
is scanned for key-shaped strings. One hit deletes the stage and exits 2.
Nothing is ever tarred.

`capsule apply` on the box extracts, swaps the token for the real home, and
keeps the target's own credentials, sessions and any existing secrets file.
`capsule provision` installs what the manifest says is missing. `capsule
doctor` runs every hook once and reports pass or fail, as text and as an
HTML page. `capsule secrets push` sends the env vars the hooks actually read,
as a mode-0600 file the hooks source through `BASH_ENV`, and never puts them
in the tarball. `capsule deploy` does the upload and bootstrap in one step,
to a Namespace devbox or to any host over plain ssh.

Zero dependencies. One Node file and the system `tar`.

## Results

| | |
|---|---|
| files packed | about 2,000 |
| tarball | 4.6 MB |
| hooks after apply | 31 of 38 pass |
| hooks after provision | 36 of 38 pass |

The two that still fail are PowerShell hooks. Stock Ubuntu has no `powershell`
package; it needs the Microsoft apt repo first, and I have not added that.

A headless Claude Code run on the box came back with my output style, my
guard hooks and my skills all active.

## Things that bit me

Most of the time went here, not in the packing logic.

- **`cargo install rtk` installs the wrong thing.** The crate of that name is
  an unrelated "Rust Type Kit". The real `rtk` ships as a musl binary on its
  GitHub releases page. The provision table now pulls it from there.
- **The devbox Python is uv-managed.** PEP 668 makes `pip install --user`
  refuse, and `uv pip install --system` targets the wrong interpreter. What
  works is `pip install --user --break-system-packages`, which despite the
  name writes only to the user site dir. Provision tries all three in order.
- **A missing `BASH_ENV` file fails silently.** If the secrets file is not
  there, every hook runs unauthenticated and the doctor still says pass,
  because the hooks exit 0 on a missing key. So `apply` never deletes an
  existing secrets file, and `secrets push` only replaces it after a
  successful transfer.
- **Remote paths from git-bash get mangled.** Give the devbox CLI an absolute
  `/home/...` path from a Windows shell and MSYS turns it into
  `C:/Program Files/Git/home/...`. Uploads are workspace-relative and moved
  into place by a second command.
- **`gh release create` on Windows splits your title on spaces** if you spawn
  it through a shell. Spawn it without one.
- **The release asset is your whole harness.** Memory files included. If you
  publish releases into the repo you later make public, they go public with it.
  Releases live in a separate private repo.
- **`--force-local` is GNU tar only.** Windows ships bsdtar, which rejects it.
  Detect which tar you have.

## What this is not

The copy-a-folder part is a commodity. There are at least seven open source
tools that sync dotfiles, and Anthropic has an open request for account-level
settings sync that would make this layer disappear. What is not commodity is
the rest: pulling in out-of-tree hook sources, translating paths and
interpreters across operating systems, describing how to install the
binaries the hooks need, and keeping secrets out of the artifact while still
getting them to the box.

A version for teams, with a shared harness, per-person scoped secrets and an
audit trail of what ran where, is a different product with a different buyer.
This repo stays a single-user tool under MIT.

## Try it

```
git clone https://github.com/<you>/agent-capsule
cd agent-capsule
node capsule.mjs pack
node capsule.mjs deploy ssh:you@your-box --force
node capsule.mjs secrets push ssh:you@your-box
```

Then open `~/capsule/doctor.html` on the box and see which hooks pass.
