#!/bin/sh
# easel-superagent ticket workspace preparation: shape the ticket directory as an Easel-style project root.
# Runs in the execution root with EASEL_SUPERAGENT_DIR naming the ticket directory; a non-zero exit fails the ticket with this stderr.
set -eu
: "${EASEL_SUPERAGENT_DIR:?EASEL_SUPERAGENT_DIR not set}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/skills/easel"

command -v python3 >/dev/null 2>&1 || { echo "prepare: python3 not found in PATH" >&2; exit 1; }
command -v ffmpeg  >/dev/null 2>&1 || { echo "prepare: ffmpeg not found in PATH" >&2;  exit 1; }
python3 -c 'import playwright' 2>/dev/null || echo "prepare: warning: python playwright not installed (needed by xiaohongshu/douyin publishing in Phase 1+)" >&2

mkdir -p "$EASEL_SUPERAGENT_DIR/outputs"
mkdir -p "$PWD/profiles"
ln -sfn "$SKILLS_SRC" "$EASEL_SUPERAGENT_DIR/skills"
ln -sfn "$PWD/profiles" "$EASEL_SUPERAGENT_DIR/profiles"
if [ -f "$PWD/.env" ]; then ln -sfn "$PWD/.env" "$EASEL_SUPERAGENT_DIR/.env";
else echo "prepare: warning: no shared .env at the execution root" >&2; fi
