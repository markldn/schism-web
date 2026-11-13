#!/usr/bin/env bash
# No build step: ES modules served as-is. Front page http://0.0.0.0:8600/, app at /schism/
exec python3 "$(dirname "$0")/serve.py" "${1:-8600}"
