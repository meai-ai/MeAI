#!/bin/bash
set -e

MEAI_DATA=${MEAI_DATA_ROOT:-/Users/allen/Documents/MeAI_data}
MEAI_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "MeAI Researcher System"
echo "  Data root: $MEAI_DATA"
echo "  Code root: $MEAI_DIR"
echo ""

# Ensure directory structure
mkdir -p "$MEAI_DATA"/{shared-state/message-claims,shared-state/status,logs,worktrees}
for bot in alpha beta gamma omega; do
  mkdir -p "$MEAI_DATA/$bot"
done

# Initialize global-mode if missing
if [ ! -f "$MEAI_DATA/shared-state/global-mode.json" ]; then
  echo "{\"mode\":\"normal\",\"updatedAt\":\"$(date -u +%FT%TZ)\",\"updatedBy\":\"system\"}" \
    > "$MEAI_DATA/shared-state/global-mode.json"
  echo "Created global-mode.json (normal)"
fi

# Watchdog self-check (clean stale locks, ensure dirs)
echo "Running watchdog self-check..."
cd "$MEAI_DIR" && npx tsx scripts/watchdog-researcher.ts --selfcheck --data-root "$MEAI_DATA" 2>&1 | tee -a "$MEAI_DATA/logs/watchdog.log"
echo ""

# Start 4 MeAI instances
for bot in alpha beta gamma omega; do
  config="$MEAI_DATA/$bot/config.json"
  if [ ! -f "$config" ]; then
    echo "WARNING: $config not found — skipping $bot"
    echo "  Run scripts/setup-researchers.ts to create configs"
    continue
  fi
  echo "Starting $bot..."
  cd "$MEAI_DIR" && MEAI_CONFIG="$config" npx tsx src/index.ts >> "$MEAI_DATA/logs/$bot.log" 2>&1 &
  echo "  PID: $!"
done

echo ""
echo "4 MeAI instances started."
echo ""
echo "Watchdog: add to crontab:"
echo "  */5 * * * * cd $MEAI_DIR && npx tsx scripts/watchdog-researcher.ts --data-root=$MEAI_DATA >> $MEAI_DATA/logs/watchdog.log 2>&1"
