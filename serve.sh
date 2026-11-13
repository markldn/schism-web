#!/usr/bin/env bash
# No build step: ES modules served as-is. http://127.0.0.1:8778
cd "$(dirname "$0")" && exec python3 -m http.server "${1:-8778}" --bind 127.0.0.1
