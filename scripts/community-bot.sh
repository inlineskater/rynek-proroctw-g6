#!/usr/bin/env bash
# Głos Biura scheduled runs → Supabase, without the Supabase connector.
# Calls public.community_bot() (supabase/community-bot.sql) over the REST API.
#
#   COMMUNITY_BOT_KEY=... scripts/community-bot.sh new_tickets
#   COMMUNITY_BOT_KEY=... scripts/community-bot.sh mark_ticket '{"id":"…","status":"not_a_bug","note":"…"}'
#
# Actions: new_tickets, recent_tickets, open_ideas, close_week,
#          mark_ticket, mark_idea, fine. The key can do nothing else.
set -euo pipefail
action="${1:?action required}"
args="${2:-{\}}"
: "${COMMUNITY_BOT_KEY:?set COMMUNITY_BOT_KEY}"
here="$(cd "$(dirname "$0")/.." && pwd)"
url="https://rjovhmepanwbdgdkvylr.supabase.co/rest/v1/rpc/community_bot"
# The anon key is public by design (it ships in index.html); RLS and grants are the boundary.
anon="$(grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' "$here/index.html" | head -1)"
body="$(python3 -c 'import json,sys; print(json.dumps({"p_key":sys.argv[1],"p_action":sys.argv[2],"p_args":json.loads(sys.argv[3])}))' \
  "$COMMUNITY_BOT_KEY" "$action" "$args")"
curl -sS -X POST "$url" -H "apikey: $anon" -H "Authorization: Bearer $anon" \
  -H "Content-Type: application/json" -d "$body"
echo
