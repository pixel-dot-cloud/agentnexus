#!/usr/bin/env bash
set -e

systemctl --user disable --now agentnexus 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/agentnexus.service"
systemctl --user daemon-reload
echo "service removed"
