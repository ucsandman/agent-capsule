# Errors and lessons

Symptom, cause, fix, date. One line for the quick ones.

- 2026-09-03: `gh release create` on a freshly created repo returned HTTP 422 "Repository is empty". A release needs at least one commit; seed the repo first.
- 2026-09-03: `release` uploaded the script asset under the name of the path it was invoked from (`capsule-head.mjs`), so `install.sh` could not download it by name. Fix: copy the script to `<out>/capsule.mjs` and upload that.
- 2026-09-03: `node --test test/` fails on Node 24 ("Cannot find module .../test"). Use the glob form `node --test test/*.test.mjs`.
- 2026-09-03: `--force-local` is GNU tar only; bsdtar on Windows rejects it. Detect via `tar --version`.
- 2026-09-03: `apt-get install powershell` exits 100 on stock Ubuntu 24.04. Root cause: the package lives in packages.microsoft.com, not the Ubuntu repos. Fix: register the repo with Microsoft's config `.deb` for `$ID/$VERSION_ID` before `apt-get update`. Doctor went 36/38 to 38/38.
- 2026-09-03: `cargo install rtk` installs an unrelated "Rust Type Kit" crate. The real `rtk` is the `rtk-ai/rtk` musl GitHub release.
- 2026-09-03: `pip install --user` and `uv pip install --system` both refuse or mis-target on a uv-managed Python 3.14 (PEP 668). `pip install --user --break-system-packages` writes only to the user site dir and works.
- 2026-09-03: A missing `env.BASH_ENV` target fails silently: hooks run unauthenticated and the doctor still passes. `apply` keeps an existing `load-secrets.sh`; `secrets push` replaces it only after a successful transfer.
- 2026-09-03: An absolute `/home/...` path given to `devbox upload` from git-bash is MSYS-mangled to `C:/Program Files/Git/home/...`. Upload workspace-relative and move into place with `devbox exec`.
- 2026-09-03: `gh release create` through a shell on Windows splits `--title` and `--notes` on spaces. Spawn without a shell.
