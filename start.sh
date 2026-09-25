#!/usr/bin/env bash
# 图片文字处理工具 · 启动脚本
set -e
cd "$(dirname "$0")"

PY=""
[ -x ".venv/bin/python" ] && PY=".venv/bin/python"
[ -z "$PY" ] && [ -x ".venv/Scripts/python.exe" ] && PY=".venv/Scripts/python.exe"
[ -z "$PY" ] && [ -x "$HOME/.workbuddy/binaries/python/envs/default/Scripts/python.exe" ] \
  && PY="$HOME/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
[ -z "$PY" ] && PY="$(command -v python3 || command -v python)"

echo
echo "  图片文字处理工具  →  http://127.0.0.1:8000"
echo "  解释器: $PY"
echo
exec "$PY" -m app.main --port 8000
