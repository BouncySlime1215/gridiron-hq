#!/bin/bash
# Gridiron HQ installer — macOS and Linux.
#
# Double-click "Install Gridiron HQ.command" instead of running this directly —
# that's the no-Terminal-typing entry point. This file is what it calls into.
#
#   git clone https://github.com/BouncySlime1215/gridiron-hq.git
#   cd gridiron-hq && ./install.sh
#
# Everything real happens in scripts/install.mjs; this only guarantees a Node new
# enough to run it, since that is the one thing a Node script cannot check for you.
set -e
cd "$(dirname "$0")"

BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
echo ""
echo "${BOLD}  Gridiron HQ — 2026 Fantasy Command Center${OFF}"
echo "  Installing for $(uname -s)…"
echo ""

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major minor
  major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null) || return 1
  minor=$(node -p "process.versions.node.split('.')[1]" 2>/dev/null) || return 1
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 5 ]; }
}

if ! node_ok; then
  if command -v node >/dev/null 2>&1; then
    echo "${YELLOW}  !${OFF} Node $(node -v) is too old — Gridiron HQ needs 22.5 or newer."
  else
    echo "${YELLOW}  !${OFF} Node.js is not installed yet."
  fi

  # Homebrew-managed Node installs to the user's own prefix (no admin password,
  # no separate download page) — the closest thing to "just works" this platform
  # has, so try it before asking the user to do anything by hand.
  if command -v brew >/dev/null 2>&1; then
    echo "  Installing Node with Homebrew (this can take a minute)…"
    if brew install node; then
      hash -r   # refresh this shell's command lookup so the new node is seen below
    fi
  fi

  if ! node_ok; then
    echo ""
    echo "${RED}  ✗ Still need a current Node.js.${OFF}"
    echo "    Opening the download page — grab the LTS installer, run it, then"
    echo "    double-click ${BOLD}Install Gridiron HQ${OFF} again."
    echo ""
    open "https://nodejs.org/en/download" 2>/dev/null || true
    exit 1
  fi
fi
echo "${GREEN}  ✓${OFF} Node $(node -v)"

exec node scripts/install.mjs "$@"
