#!/usr/bin/env bash
# Start the local MongoDB as a single-node replica set.
#
# The replica set is not optional: it gives us
#   (a) multi-document transactions  — sale + stock + receipt counter commit together
#   (b) change streams                — clean push-sync in Phase 10
#
# Usage: npm run mongo:start     (Ctrl+C stops it; or run with --bg)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT/.mongo-data"
LOG_FILE="$ROOT/.mongo-data/mongod.log"

command -v mongod >/dev/null 2>&1 || {
  echo "mongod not found. Install with: brew tap mongodb/brew && brew install mongodb-community"
  exit 1
}

mkdir -p "$DATA_DIR"

# Already running?
if pgrep -x mongod >/dev/null 2>&1; then
  echo "[mongo] mongod already running (pid $(pgrep -x mongod | head -1))"
  exit 0
fi

# Authorization on a replica set requires a keyfile (mongod: "security.keyFile
# is required when authorization is enabled with replica sets"). Generate a
# local one on first run. (--keyFile implies --auth.)
KEY_FILE="$DATA_DIR/mongod-key"
if [ ! -f "$KEY_FILE" ]; then
  openssl rand -base64 756 > "$KEY_FILE"   # keyfiles must be 6..1024 chars
  chmod 600 "$KEY_FILE"
  echo "[mongo] generated keyfile $KEY_FILE"
fi

echo "[mongo] starting mongod --replSet rs0 --auth --dbpath $DATA_DIR"
# NOTE: --fork is unsupported on macOS (mongod 9+); run in background instead.
mongod \
  --replSet rs0 \
  --auth \
  --keyFile "$KEY_FILE" \
  --dbpath "$DATA_DIR" \
  --bind_ip 127.0.0.1 \
  --port 27017 \
  --logpath "$LOG_FILE" >/dev/null 2>&1 &
MONGOD_PID=$!

# wait for mongod to accept connections
for i in $(seq 1 60); do
  if mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1; then
    echo "[mongo] started (pid $MONGOD_PID). Next: npm run mongo:rs-init"
    exit 0
  fi
  sleep 0.5
done
echo "[mongo] mongod did not become ready in 30s; check $LOG_FILE"
exit 1
