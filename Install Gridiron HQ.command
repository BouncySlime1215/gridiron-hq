#!/bin/bash
# Double-click this file to install Gridiron HQ. No Terminal typing required.
#
# The first time you double-click it, macOS will warn that it's from an
# unidentified developer (normal for any downloaded script, and only happens
# once). On newer macOS the warning only offers "Done" / "Move to Trash" — if
# so, click Done (not Trash), then either:
#   - System Settings -> Privacy & Security -> scroll down -> "Open Anyway", or
#   - in Terminal: xattr -d com.apple.quarantine "path/to/this/file"
# See the README for the full walkthrough.
cd "$(dirname "$0")"
./install.sh
echo ""
read -r -p "Press Enter to close this window… "
