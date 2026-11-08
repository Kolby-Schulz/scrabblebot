#!/bin/zsh
# Keep LexiconWarrior connected: restart on any exit, keep the Mac awake.
# Usage (from bot/): BOT_NAME=ruthless [TOURNAMENT_ID=<id>] caffeinate -dims ./scripts/live.sh
cd "$(dirname "$0")/.."
export PATH=/usr/local/bin:$PATH
while true; do
  npx tsx src/index.ts
  echo "[live.sh] bot exited with $?; restarting in 2s ($(date +%T))"
  sleep 2
done
