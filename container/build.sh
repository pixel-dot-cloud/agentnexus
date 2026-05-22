#!/usr/bin/env bash
# Build the agentnexus-runner Docker image.
# Tags both <sha> and :latest.
# Run from repo root or from the container/ directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "local")
TAG="agentnexus-runner:${SHA}"
LATEST="agentnexus-runner:latest"

echo "[build.sh] Building dist..."
cd "$REPO_ROOT"
npm run build

echo "[build.sh] Building image $TAG..."
docker build -f container/Dockerfile -t "$TAG" -t "$LATEST" .

echo "[build.sh] Done — built $TAG (also tagged $LATEST)"
