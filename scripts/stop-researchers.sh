#!/bin/bash

MEAI_DATA=${MEAI_DATA_ROOT:-/Users/allen/Documents/MeAI_data}

echo "Stopping MeAI researchers..."

for bot in alpha beta gamma omega; do
  lockfile="$MEAI_DATA/$bot/run.lock"
  if [ -f "$lockfile" ]; then
    pid=$(cat "$lockfile" | python3 -c "import sys,json; print(json.load(sys.stdin)['pid'])" 2>/dev/null || echo "")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "  Stopping $bot (PID $pid)..."
      kill -TERM "$pid"
    else
      echo "  $bot not running (stale lock)"
      rm -f "$lockfile"
    fi
  else
    echo "  $bot not running (no lock)"
  fi
done

echo "Waiting for graceful shutdown..."
sleep 5

# Verify all stopped
for bot in alpha beta gamma omega; do
  lockfile="$MEAI_DATA/$bot/run.lock"
  if [ -f "$lockfile" ]; then
    pid=$(cat "$lockfile" | python3 -c "import sys,json; print(json.load(sys.stdin)['pid'])" 2>/dev/null || echo "")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "  WARNING: $bot (PID $pid) still running"
    else
      rm -f "$lockfile"
    fi
  fi
done

echo "Done."
