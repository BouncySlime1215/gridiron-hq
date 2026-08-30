#!/bin/bash
# GRIDIRON HQ — double-click this file. That is the whole installation.
#
# You do not need Node, Homebrew, Xcode, or anything else installed first.
# If Node is missing this fetches an official private copy into ~/.gridiron.
# Nothing is installed system-wide and no administrator password is needed.
#
# macOS may block this unsigned downloaded script the first time. The installer
# does not disable Gatekeeper or change security settings. On macOS 15+, try to
# open it once, then use System Settings > Privacy & Security > Open Anyway.
# On macOS 14 and older, Control-click the file, choose Open, then click Open.

set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

BOLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'

printf '\n  %s\n' "${BOLD}Gridiron HQ${OFF}"
printf '  %s\n\n' "${DIM}Fantasy football + NFL market analytics${OFF}"

chmod +x "$ROOT"/mac/*.command "$ROOT"/install.sh 2>/dev/null || true
exec "$ROOT/install.sh" "$@"
