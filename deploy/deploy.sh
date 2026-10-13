#!/bin/bash
# Server-side deploy for spiders. Installed at /opt/spiders/deploy.sh (root-owned) and
# invoked via a forced-command SSH key: tar of source on stdin, commit SHA as the SSH command.
set -euo pipefail
BASE=/opt/spiders
SHA="${SSH_ORIGINAL_COMMAND:-${1:-}}"
[[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || { echo "invalid sha: '$SHA'" >&2; exit 2; }
SHA="${SHA:0:7}"
exec 9>"$BASE/.deploy.lock"
flock -w 600 9 || { echo "another deploy is running" >&2; exit 3; }
log(){ echo "[deploy $(date '+%F %T')] $*"; }

NEW="$BASE/app-new"
rm -rf "$NEW"; mkdir -p "$NEW"
tar -x -C "$NEW"
[ -f "$NEW/package.json" ] || { echo "empty/invalid archive" >&2; exit 4; }
[ -f "$NEW/Dockerfile" ] || cp "$BASE/Dockerfile" "$NEW/Dockerfile"
[ -f "$NEW/.dockerignore" ] || cp "$BASE/.dockerignore" "$NEW/.dockerignore"
echo "$SHA" > "$NEW/.deployed-commit"

log "building spiders:$SHA"
docker build -q -t "spiders:$SHA" "$NEW"

PREV_IMG="$(docker inspect -f '{{.Config.Image}}' spiders 2>/dev/null || true)"
run(){ docker run -d --name spiders --restart unless-stopped --init -p 127.0.0.1:8787:8787 \
  --memory 768m --memory-swap 768m --cpus 1.5 --log-opt max-size=10m --log-opt max-file=3 \
  -e HOST=0.0.0.0 -e PORT=8787 -e SPIDERS_DATA_DIR=/app/data -v "$BASE/data:/app/data" \
  $( [ -f "$BASE/spiders.env" ] && echo --env-file "$BASE/spiders.env" ) "$1" >/dev/null; }
healthy(){ for i in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/ || true)" = 200 ] && return 0; sleep 2; done; return 1; }

log "swapping container ($PREV_IMG -> spiders:$SHA)"
docker rm -f spiders >/dev/null 2>&1 || true
run "spiders:$SHA"
if ! healthy; then
  log "health check FAILED, rolling back to $PREV_IMG"
  docker logs --tail 50 spiders >&2 || true
  docker rm -f spiders >/dev/null 2>&1 || true
  [ -n "$PREV_IMG" ] && run "$PREV_IMG" && healthy && log "rollback ok"
  exit 5
fi

log "running ingest (FTS rebuild)"
docker exec spiders node --import tsx MOOC/ingest.ts || log "WARNING: ingest failed"

rm -rf "$BASE/app-prev"
[ -d "$BASE/app" ] && mv "$BASE/app" "$BASE/app-prev"
mv "$NEW" "$BASE/app"
docker tag "spiders:$SHA" spiders:latest
# cron schedule lives in the repo (deploy/cron/spiders-career); install idempotently (only when changed)
CRON_SRC="$BASE/app/deploy/cron/spiders-career"
if [ -f "$CRON_SRC" ] && ! cmp -s "$CRON_SRC" /etc/cron.d/spiders-career; then
  install -m 0644 -o root -g root "$CRON_SRC" /etc/cron.d/spiders-career && log "installed /etc/cron.d/spiders-career"
fi
docker images spiders --format '{{.Tag}} {{.CreatedAt}}' | grep -vE '^(latest|<none>) ' | sort -k2 -r | awk 'NR>3{print $1}' \
  | while read -r t; do [ "spiders:$t" = "spiders:$SHA" ] || docker rmi "spiders:$t" >/dev/null 2>&1 || true; done
docker image prune -f >/dev/null 2>&1 || true
log "deployed $SHA"
