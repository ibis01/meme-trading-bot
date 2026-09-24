#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -f logs/recorder.pid ]; then
  echo "No PID file. Recorder not running."
  exit 0
fi
PID="$(cat logs/recorder.pid)"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Sent SIGTERM to $PID."
else
  echo "Process $PID not running. Cleaning up PID file."
fi
rm -f logs/recorder.pid
