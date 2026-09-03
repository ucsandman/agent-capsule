# Decisions

One line per durable choice, newest first. Rationale lives in the commit that made it.

- 2026-09-03: PowerShell on Linux is installed through Microsoft's per-release config `.deb` (packages.microsoft.com), not the GitHub tarball. It needs sudo, so it stays behind `--apt`; a tarball route would drop the sudo need but the asset name carries a version and the extract is a directory, not one binary.
- 2026-09-03: `capsule.config.json` is committed with the author's values. The repo doubles as the dotfiles target for `devbox create --dotfiles`, which needs the config in the checkout, and nothing in it is secret.
- 2026-09-03: Releases go to a separate private repo (`release.repo`), never to this one. The asset is the whole harness, memory included, and a public repo publishes its releases.
- 2026-09-03: Single-user tool under MIT. A team version (shared harness, per-person scoped secrets, audit trail) is a different product and is not built here.
- 2026-09-03: Zero dependencies stays a rule. Tests use `node --test`, the HTML report is a string template, transports are `spawnSync` without a shell.
- 2026-09-03: Targets are a Namespace devbox name or `ssh:HOST`. No other transports until someone needs one.
