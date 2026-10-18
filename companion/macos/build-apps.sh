#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo 'The app helper requires macOS.' >&2
  exit 1
fi
task_root="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$task_root/.build"
swiftc -module-cache-path "$task_root/.build/ModuleCache" -O -framework AppKit -framework Security "$task_root/AppHelper.swift" -o "$task_root/.build/fo-reach-apps"
echo 'Built fixed app helper; no apps launched or permissions changed.'
