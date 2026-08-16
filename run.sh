#!/bin/bash
set -euo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  source .env
  set +a
else
  echo "Missing .env file. Copy .env.example to .env and fill in your API keys." >&2
  exit 1
fi

echo "=== Run started: $(date) ==="
node fetchData.js
node screener.js
echo "=== Done ==="
