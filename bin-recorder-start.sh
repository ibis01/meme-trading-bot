#!/usr/bin/env bash
# Launch the recorder in the background, detached from the terminal.
# Logs to logs/recorder.log; PID written to logs/recorder.pid.
set -e
cd "$(dirname "$0")"
mkdir -p logs
if [ -f logs/recorder.pid ] && kill -0 "$(cat logs/recorder.pid)" 2>/dev/null; then
  echo "Recorder already running (pid $(cat logs/recorder.pid))."
  exit 0
fi
nohup npm run recorder >> logs/recorder.log 2>&1 &
echo $! > logs/recorder.pid
echo "Recorder started (pid $(cat logs/recorder.pid)). Logs: logs/recorder.log"
