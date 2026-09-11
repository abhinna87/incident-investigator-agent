#!/usr/bin/env bash
# Post a synthetic incident at a locally running agent.
#
#   ./seeds/send.sh pagerduty-tunnel-down.json
#   ./seeds/send.sh jira-routing-churn.json  [http://localhost:8787]
#
# Works unsigned because wrangler.jsonc sets ALLOW_UNSIGNED_WEBHOOKS for local
# dev. A deployed instance requires a real HMAC signature.
set -euo pipefail
FILE="${1:?usage: send.sh <seed.json> [base-url]}"
BASE="${2:-http://localhost:8787}"
DIR="$(cd "$(dirname "$0")" && pwd)"
case "$FILE" in
  *pagerduty*) PROVIDER=pagerduty ;;
  *jira*)      PROVIDER=jira ;;
  *) echo "cannot infer provider from filename: $FILE" >&2; exit 1 ;;
esac
echo "POST $BASE/webhooks/$PROVIDER  <-  $FILE"
curl -sS -X POST "$BASE/webhooks/$PROVIDER" \
  -H 'content-type: application/json' \
  --data-binary "@$DIR/$FILE" | tee /dev/stderr | python3 -m json.tool 2>/dev/null || true
echo
