#!/bin/sh
# Pull the encrypted data repo to this Mac so a full local copy always exists
# (and lands in Time Machine). Clones on first run, pulls after.
# Usage: tools/mirror.sh [target-dir]     (default: ~/Documents/Projects/monolith-data)
set -e
REPO="git@github.com:HenryBrockman17/monolith-data.git"
DIR="${1:-$HOME/Documents/Projects/monolith-data}"

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --quiet
  echo "mirror updated: $DIR"
else
  git clone --quiet "$REPO" "$DIR"
  echo "mirror created: $DIR"
fi
# Decrypt a plaintext export any time with:
#   node tools/decrypt-export.mjs "$DIR"
