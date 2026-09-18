#!/bin/zsh
# Start Caddy for canvas.generalwu.com with credentials from caddy.env.
# Managed by LaunchAgent com.generalwu.canvas-caddy.
set -e
DEPLOY_DIR="/Users/johncarter/Documents/Script/open-canvas/deploy"
cd "$DEPLOY_DIR"
set -a
. ./caddy.env
set +a

# The open-canvas container must be up before Caddy proxies to 127.0.0.1:8090.
if command -v docker >/dev/null 2>&1; then
  docker ps --filter name=open-canvas --format "{{.Names}}" | grep -q open-canvas || \
    (cd "$DEPLOY_DIR/.." && docker compose up -d >> "$DEPLOY_DIR/canvas-startup.log" 2>&1)
fi

exec ./bin/caddy run --config Caddyfile --adapter caddyfile
