#!/usr/bin/env bash
# Backup: Postgres dump (decks, Yjs state, chats, settings) and /data (deck files with
# Git history, briefings, uploaded templates). Run on the host next to docker-compose.yml,
# e.g. nightly:  0 2 * * *  cd /opt/slidango && deploy/backup.sh >> backups/backup.log 2>&1
#
# Usage: deploy/backup.sh [target-dir]   (default: $BACKUP_DIR or ./backups)
# Keeps the newest $BACKUP_KEEP backups (default 14).
set -euo pipefail
cd "$(dirname "$0")/.."

target=${1:-${BACKUP_DIR:-./backups}}
keep=${BACKUP_KEEP:-14}
dir="$target/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$dir"

# Flush: Yjs state is stored at most a few seconds after the last edit; the dump
# is the source of truth on restore and rewrites slides.md from it.
docker compose exec -T postgres pg_dump -U slides -Fc slides > "$dir/db.dump"

# Per-deck node_modules only hold links and caches; they are rebuilt on demand.
docker compose exec -T app tar -C /data --exclude='./decks/*/node_modules' -czf - . > "$dir/data.tgz"

echo "ok $(date -Is) $dir db=$(du -h "$dir/db.dump" | cut -f1) data=$(du -h "$dir/data.tgz" | cut -f1)"

# Rotation: newest first, drop everything after $keep.
ls -1d "$target"/[0-9]*-[0-9]*/ 2>/dev/null | sort -r | tail -n +$((keep + 1)) | xargs -r rm -rf
