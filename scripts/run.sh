#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Support both source checkouts (scripts/run.sh + dist/server) and extracted
# artifacts (scripts/run.sh + server). Keep cwd aligned with runtime env files.
if [[ -f "$SCRIPT_DIR/../dist/server/main.js" ]]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  ENTRYPOINT="$PROJECT_ROOT/dist/server/main.js"
elif [[ -f "$SCRIPT_DIR/../server/main.js" ]]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  ENTRYPOINT="$PROJECT_ROOT/server/main.js"
elif [[ -f "$SCRIPT_DIR/server/main.js" ]]; then
  PROJECT_ROOT="$SCRIPT_DIR"
  ENTRYPOINT="$PROJECT_ROOT/server/main.js"
else
  echo "Production server entrypoint not found" >&2
  exit 1
fi

cd "$PROJECT_ROOT"
exec env NODE_ENV="${NODE_ENV:-production}" node "$ENTRYPOINT"
