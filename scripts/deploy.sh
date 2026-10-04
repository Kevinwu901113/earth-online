#!/bin/sh
# Docker-only Linux/macOS launcher; Node.js does not need to be installed on the host.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
action=${1:-help}
if [ "$#" -gt 0 ]; then shift; fi
production=false
for option in "$@"; do
  case "$option" in
    --production) production=true ;;
    --domain=*) [ "$action" = init ] || { echo '--domain is only used by init' >&2; exit 1; } ;;
    *) echo "Unknown option: $option" >&2; exit 1 ;;
  esac
done
case "$action" in
  help) echo 'sh scripts/deploy.sh init|check|up|down|status|logs|backup|update [--production] [--domain=your.domain]'; exit 0 ;;
  init|check|up|down|status|logs|backup|update) ;;
  *) echo "Unknown command: $action" >&2; exit 1 ;;
esac
validator() {
  docker run --rm --user "$(id -u):$(id -g)" --volume "$PWD:/app$mount_mode" --workdir /app \
    node:24-bookworm-slim node scripts/deploy.js "$@"
}
if [ "$action" = init ]; then
  mount_mode=''
  validator init "$@"
  exit 0
fi
# Require an explicit production flag in this launcher to avoid selecting the wrong stack.
mount_mode=:ro
validator validate "$@"
if [ "$production" = false ] && [ -f .env ]; then
  # Never source .env as shell code. Detect production through the Node validator instead.
  docker run --rm --user "$(id -u):$(id -g)" --volume "$PWD:/app:ro" --workdir /app \
    node:24-bookworm-slim node -e 'const fs=require("node:fs"),util=require("node:util"); if(util.parseEnv(fs.readFileSync(".env","utf8")).NODE_ENV==="production") { console.error("Add --production for this environment."); process.exit(1); }'
fi
compose() {
  if [ "$production" = true ]; then
    docker compose --project-name earth-online --env-file .env -f compose.production.yaml "$@"
  else
    docker compose --project-name earth-online --env-file .env -f compose.yaml -f compose.app.yaml "$@"
  fi
}
backup() {
  mkdir -p backups
  chmod 700 backups
  file=$(mktemp "backups/earth-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.dump")
  # mktemp creates a private, unique file; remove an incomplete dump on failure.
  if (umask 077; compose exec -T postgres pg_dump -U earth -d earth_online --format=custom > "$file"); then
    echo "Backup saved: $file"
  else
    rm -f "$file"
    return 1
  fi
}
up() {
  compose config --quiet
  compose build
  compose rm -s -f migrate
  compose up -d --wait --wait-timeout 180
  echo 'Services started. Verify DNS/HTTPS and a real AI task; a running worker alone does not prove model access.'
}
case "$action" in
  check) docker compose version; docker info --format '{{.ServerVersion}}'; compose config --quiet ;;
  up) up ;;
  down) compose down ;;
  status) compose ps -a ;;
  logs) compose logs --tail 100 -f ;;
  backup) backup ;;
  update)
    [ -z "$(git status --porcelain)" ] || { echo 'Commit or stash source changes first.' >&2; exit 1; }
    backup
    git pull --ff-only
    compose build
    compose stop api worker
    compose rm -s -f migrate
    compose up -d --wait --wait-timeout 180
    echo 'Update complete; verify status and one real AI task. Schema rollback is manual.'
    ;;
esac
