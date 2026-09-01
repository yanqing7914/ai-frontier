#!/usr/bin/env bash
set -euo pipefail

url="${1:-}"
if [[ -z "$url" ]]; then
  echo "usage: $0 <url>" >&2
  exit 2
fi

echo "Checking $url"
curl --fail --silent --show-error --location --max-time 15 \
  --retry 3 --retry-delay 2 --retry-connrefused \
  --output /dev/null "$url"
echo "Healthcheck passed"

