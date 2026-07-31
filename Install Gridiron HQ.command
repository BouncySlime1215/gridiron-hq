#!/bin/bash
# Double-click this file to install Gridiron HQ. No Terminal typing required.
#
# The first time you double-click it, macOS will warn that it's from an
# unidentified developer (normal for any downloaded script, and only happens
# once) — right-click this file instead and choose "Open" to get past that.
cd "$(dirname "$0")"
./install.sh
echo ""
read -r -p "Press Enter to close this window… "
