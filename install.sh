#!/bin/bash
# Gridiron HQ installer — macOS and Linux.
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

if ! command -v node >/dev/null 2>&1; then
  echo "${RED}  ✗ Node.js is not installed.${OFF}"
  echo ""
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "    Install it with Homebrew:"
    echo "      ${BOLD}brew install node${OFF}"
    echo "    or download the LTS installer from ${BOLD}https://nodejs.org${OFF}"
  else
    echo "    Install it from ${BOLD}https://nodejs.org${OFF} or your package manager:"
    echo "      ${BOLD}sudo apt install nodejs npm${OFF}    (Debian/Ubuntu)"
    echo "      ${BOLD}sudo dnf install nodejs${OFF}        (Fedora)"
  fi
  echo ""
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
MINOR=$(node -p "process.versions.node.split('.')[1]")
if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 5 ]; }; then
  echo "${RED}  ✗ Node $(node -v) is too old — Gridiron HQ needs 22.5 or newer.${OFF}"
  echo "    The app stores data with Node's built-in SQLite, which arrived in 22.5."
  echo "    Grab the current LTS from ${BOLD}https://nodejs.org${OFF} and run this again."
  echo ""
  exit 1
fi
echo "${GREEN}  ✓${OFF} Node $(node -v)"

exec node scripts/install.mjs "$@"
