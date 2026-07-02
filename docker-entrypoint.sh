#!/usr/bin/env sh
set -eu

: "${GRANITE_VAULT:=/vault}"
export GRANITE_VAULT

if [ ! -f "$GRANITE_VAULT/granite.yml" ]; then
  mkdir -p "$GRANITE_VAULT"
  if [ -n "${GRANITE_INIT_TEMPLATE:-}" ]; then
    granite init --template "$GRANITE_INIT_TEMPLATE"
  else
    granite init
  fi
fi

if [ "$#" -eq 0 ]; then
  set -- granite mcp --transport http --host 0.0.0.0
elif [ "${1#-}" != "$1" ]; then
  set -- granite mcp --transport http --host 0.0.0.0 "$@"
fi

exec "$@"
