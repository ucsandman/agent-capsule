#!/usr/bin/env bash
# agent-capsule bootstrap — idempotent installer for a fresh box.
#   devbox create <name> --dotfiles https://github.com/ucsandman/agent-capsule --setup_github
# then run this script (Namespace runs dotfiles install.sh automatically when present).
# Sources for capsule.tgz + capsule.mjs, in order: already in $DEST -> gh release -> $CAPSULE_URL -> dotfiles checkout.
set -euo pipefail
REPO="${CAPSULE_REPO:-ucsandman/agent-capsule}"
DEST="${CAPSULE_DEST:-$HOME/capsule}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.local/node_modules/.bin:$PATH"
mkdir -p "$DEST"

if [ -s "$DEST/capsule.tgz" ] && [ -s "$DEST/capsule.mjs" ]; then
  echo "[capsule] found $DEST/capsule.tgz + capsule.mjs — skipping download"
else
  if command -v gh >/dev/null 2>&1 &&
     gh release download --repo "$REPO" --pattern capsule.tgz --pattern capsule.mjs --dir "$DEST" --clobber >/dev/null 2>&1; then
    echo "[capsule] downloaded release assets from $REPO"
  elif [ -n "${CAPSULE_URL:-}" ] && curl -fsSL "$CAPSULE_URL" -o "$DEST/capsule.tgz"; then
    echo "[capsule] downloaded capsule.tgz from CAPSULE_URL"
  else
    echo "[capsule] no release download available; falling back to the dotfiles checkout"
  fi
fi
if [ ! -s "$DEST/capsule.mjs" ]; then
  for cand in "$SCRIPT_DIR/../capsule.mjs" "$SCRIPT_DIR/capsule.mjs"; do
    if [ -s "$cand" ]; then cp "$cand" "$DEST/capsule.mjs"; echo "[capsule] capsule.mjs from $cand"; break; fi
  done
fi
[ -s "$DEST/capsule.tgz" ] || { echo "[capsule] ERROR: no capsule.tgz (set CAPSULE_URL or publish a release)"; exit 1; }
[ -s "$DEST/capsule.mjs" ] || { echo "[capsule] ERROR: no capsule.mjs"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "[capsule] ERROR: node is required"; exit 1; }

if [ -s "$HOME/.claude/.capsule-manifest.json" ] && [ "${CAPSULE_FORCE:-0}" != "1" ]; then
  echo "[capsule] harness already applied (CAPSULE_FORCE=1 to re-apply)"
else
  node "$DEST/capsule.mjs" apply "$DEST/capsule.tgz" > "$DEST/apply.log" 2>&1 || { tail -20 "$DEST/apply.log"; exit 1; }
  echo "[capsule] applied: $(grep -m1 'restored files:' "$DEST/apply.log" || echo 'see apply.log')"
fi

# provision installs missing hook dependencies; one failure must not abort the bootstrap
node "$DEST/capsule.mjs" provision ${CAPSULE_APT:+--apt} > "$DEST/provision.log" 2>&1 || true
grep -E '^doctor before:' "$DEST/provision.log" || tail -5 "$DEST/provision.log"

# doctor exits 1 whenever any hook fails, which is normal on a box missing optional tools
node "$DEST/capsule.mjs" doctor > "$DEST/doctor.log" 2>&1 || true
echo "[capsule] $(grep -E '^hooks: ' "$DEST/doctor.log" || echo 'doctor produced no summary — see doctor.log')"
echo "[capsule] logs in $DEST (apply.log, provision.log, doctor.log)"
echo "[capsule] secrets: run 'capsule secrets push <devbox-name>' from the source machine"
