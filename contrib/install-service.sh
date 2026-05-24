#!/usr/bin/env bash
set -e

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(which node)"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/agentnexus.service"

if [ -z "$NODE_BIN" ]; then
  echo "error: node not found in PATH"
  exit 1
fi

mkdir -p "$SERVICE_DIR"

sed -e "s|NODE_BIN|$NODE_BIN|g" \
    -e "s|INSTALL_DIR|$INSTALL_DIR|g" \
    "$INSTALL_DIR/contrib/agentnexus.service" > "$SERVICE_FILE"

systemctl --user daemon-reload
systemctl --user enable --now agentnexus

STATUS="$(systemctl --user is-active agentnexus)"
echo "installed: $SERVICE_FILE"
echo "status:    $STATUS"
echo "logs:      journalctl --user -u agentnexus -f"
echo ""
echo "to survive logout: loginctl enable-linger $USER"
