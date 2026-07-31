#!/bin/bash
# Double-click this file to install Gridiron HQ. No Terminal typing required.
#
# The first time you double-click it, macOS will warn that it's from an
# unidentified developer (normal for any downloaded script, only happens once).
# If double-clicking does nothing: System Settings -> Privacy & Security ->
# scroll down -> "Open Anyway" next to this file's name, confirm, then
# double-click again. See the README for the full walkthrough.
cd "$(dirname "$0")"
./install.sh
echo ""
read -r -p "Press Enter to close this window… "
