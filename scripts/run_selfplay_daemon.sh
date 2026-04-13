#!/bin/zsh
set -e
cd "/Users/headplus/Documents/New project"
set -a
source /tmp/jnby_env_prod
set +a
export SELFPLAY_MODE=local
export SELFPLAY_RUN_FOREVER=1
export SELFPLAY_INTERVAL_MS=900
node scripts/minimax_selfplay_runner.mjs
