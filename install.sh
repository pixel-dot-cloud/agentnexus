#!/usr/bin/env bash
# agentnexus installer
# installs to ~/.local/share/agentnexus and links the binary to ~/.local/bin/agentnexus

set -e

REPO="pixel-dot-cloud/agentnexus"
INSTALL_DIR="${AGENTNEXUS_DIR:-$HOME/.local/share/agentnexus}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
VERSION="0.1.0"

log()  { echo "  $*"; }
fail() { echo "error: $*" >&2; exit 1; }

echo "agentnexus $VERSION installer"
echo ""

# prereqs
command -v node  >/dev/null 2>&1 || fail "node not found. Install Node.js 18+ and retry."
command -v npm   >/dev/null 2>&1 || fail "npm not found."
command -v git   >/dev/null 2>&1 || fail "git not found."

NODE_MAJOR=$(node -e "process.stdout.write(String(parseInt(process.versions.node)))")
[ "$NODE_MAJOR" -ge 18 ] || fail "node $NODE_MAJOR found, need 18+."
log "node v$(node --version | tr -d v) ok"

if ! command -v docker >/dev/null 2>&1; then
  log "docker not found — container mode will be unavailable"
fi

# clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  log "updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  log "cloning into $INSTALL_DIR"
  if command -v gh >/dev/null 2>&1; then
    gh repo clone "$REPO" "$INSTALL_DIR" -- --depth=1
  else
    git clone "https://github.com/$REPO.git" "$INSTALL_DIR" --depth=1
  fi
fi

cd "$INSTALL_DIR"

log "installing dependencies"
npm install --silent

log "building"
npm run build --silent

# link binary
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/agentnexus" "$BIN_DIR/agentnexus"
log "linked $BIN_DIR/agentnexus"

# PATH hint
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  echo ""
  echo "  add to your shell profile:"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo ""
echo "done. next steps:"
echo "  agentnexus setup          configure providers and Telegram bots"
echo "  agentnexus serve          start the daemon"
echo ""
echo "  to run as a background service:"
echo "    bash $INSTALL_DIR/contrib/install-service.sh"
echo "    loginctl enable-linger \$USER   # survive logout"
