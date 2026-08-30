#!/bin/bash
# Double-click to start Gridiron HQ. It opens in your browser by itself.
#
# Leave this window open while you use the app — closing it stops the server.
# Press Control-C in here, or just close the window, when you are done.
cd "$(dirname "$0")/.."

# If the installer fetched a private Node, it is not on the system PATH — this
# window would otherwise report "command not found: npm" on a machine where the
# app is installed and working perfectly.
[ -x "$HOME/.gridiron/node/bin/node" ] && export PATH="$HOME/.gridiron/node/bin:$PATH"

if ! command -v npm >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is missing. Double-click 'Install Gridiron HQ' in this folder first."
  echo ""
  read -r -p "  Press Enter to close… "
  exit 1
fi

echo ""
echo "  Starting Gridiron HQ — your browser will open in a moment."
echo "  Keep this window open. Close it to stop the app."
echo ""
npm start
