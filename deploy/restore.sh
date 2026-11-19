#!/usr/bin/env bash
# Restores a backup made by deploy/backup.sh, e.g. on a fresh host after
# `cp .env.example .env` (same POSTGRES_PASSWORD not required).
#
# Usage: deploy/restore.sh <backup-dir>
# Replaces the database and /data completely.
set -euo pipefail
cd "$(dirname "$0")/.."

dir=${1:?usage: deploy/restore.sh <backup-dir>}
[[ -f "$dir/db.dump" && -f "$dir/data.tgz" ]] || { echo "missing $dir/db.dump or $dir/data.tgz" >&2; exit 1; }

docker compose up -d --wait postgres
docker compose stop app

docker compose exec -T postgres pg_restore -U slides -d slides --clean --if-exists --no-owner < "$dir/db.dump"
docker compose run --rm --no-deps -T --entrypoint sh app -c 'find /data -mindepth 1 -delete && tar -C /data -xzf -' < "$dir/data.tgz"

docker compose up -d
echo "restored $dir"
