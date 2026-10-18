#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo 'The CoreAudio helper can only compile on macOS. Cloud fixture mode needs no native build.' >&2
  exit 1
fi
task_root="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$task_root/.build"
swiftc -module-cache-path "$task_root/.build/ModuleCache" -O -framework CoreAudio -framework Foundation "$task_root/AudioHelper.swift" -o "$task_root/.build/fo-fix-audio"
echo "Built $task_root/.build/fo-fix-audio (not installed, launched, or granted permissions)."
