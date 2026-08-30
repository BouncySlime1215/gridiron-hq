#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  GRIDIRON HQ — double-click this file. That is the whole installation.
# ═══════════════════════════════════════════════════════════════════════
#
# You do not need Node, Homebrew, Xcode, or anything else installed first.
# If Node is missing this fetches a private copy into ~/.gridiron and uses
# that — nothing is installed system-wide and no password is ever asked for.
#
# WHY MACOS MIGHT BLOCK THIS THE FIRST TIME
# Anything downloaded from the internet is tagged by the browser, and macOS
# refuses to run tagged scripts from an unidentified developer. This project
# is not signed with a $99/yr Apple certificate, so that warning is expected.
# The first run clears that tag only from this extracted Gridiron HQ folder,
# so you will see the warning at most once. To get past it:
#
#   macOS 15 (Sequoia) and newer:
#     System Settings → Privacy & Security → scroll down →
#     "Open Anyway" next to this file's name → double-click again.
#
#   macOS 14 and older:
#     Right-click (or Control-click) this file → Open → Open.
#
# Read this script first if you want to know exactly what it runs.

set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RED=$'\033[31m'
YELLOW=$'\033[33m'; OFF=$'\033[0m'

printf '\n  %s\n' "${BOLD}Gridiron HQ${OFF}"
printf '  %s\n\n' "${DIM}Fantasy football + NFL market analytics${OFF}"

chmod +x "$ROOT"/mac/*.command "$ROOT"/install.sh 2>/dev/null || true

# ── Clear quarantine only inside this Gridiron HQ bundle ────────────────
if xattr -pr com.apple.quarantine "$ROOT" >/dev/null 2>&1; then
  printf '  %s Clearing the macOS download flag from Gridiron HQ…\n' "${YELLOW}!${OFF}"
  xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null || true
  printf '  %s Gridiron HQ is approved for future launches.\n' "${GREEN}✓${OFF}"
fi

# ── Make sure a usable Node exists ──────────────────────────────────────
exec "$ROOT/install.sh"
