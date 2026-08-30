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
GRIDIRON_RUNTIME_ROOT=${GRIDIRON_RUNTIME_ROOT:-"$HOME/.gridiron"}
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

  # Fetch an official Node build into a private folder instead of changing the
  # machine's package manager or asking for administrator access.
  #
  # This is the difference between "install these three things first" and
  # "double-click". It writes only to ~/.gridiron, needs no admin password,
  # touches nothing system-wide, and is the same tarball nodejs.org serves from
  # its own installer — so uninstalling is `rm -rf ~/.gridiron`.
  if ! node_ok; then
    PRIVATE_NODE="$GRIDIRON_RUNTIME_ROOT/node"
    if [ -x "$PRIVATE_NODE/bin/node" ]; then
      export PATH="$PRIVATE_NODE/bin:$PATH"
      hash -r
    fi
  fi
  if ! node_ok; then
    echo "  No system Node.js — fetching a private copy (about 50 MB, one time)…"
    case "$(uname -s)" in
      Darwin) PLAT=darwin ;;
      *)      PLAT=linux ;;
    esac
    case "$(uname -m)" in
      arm64|aarch64) ARCH=arm64 ;;
      *)             ARCH=x64 ;;
    esac
    # Ask nodejs.org which release is current LTS rather than pinning a version
    # that quietly rots. The pin is only the fallback for when that lookup fails.
    NODE_VER=$(curl -fsSL --max-time 20 https://nodejs.org/dist/index.json 2>/dev/null \
      | tr '{' '\n' | grep '"lts":"[A-Z]' | head -1 \
      | sed -n 's/.*"version":"\(v[0-9.]*\)".*/\1/p')
    [ -n "$NODE_VER" ] || NODE_VER=v22.20.0
    TARBALL="node-${NODE_VER}-${PLAT}-${ARCH}.tar.gz"
    TMP="$(mktemp -d)"
    if curl -fL --progress-bar --max-time 600 \
         "https://nodejs.org/dist/${NODE_VER}/${TARBALL}" -o "$TMP/node.tar.gz" \
       && curl -fsSL --max-time 60 "https://nodejs.org/dist/${NODE_VER}/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"; then
      EXPECTED=$(awk -v file="$TARBALL" '$2 == file { print $1 }' "$TMP/SHASUMS256.txt")
      if command -v shasum >/dev/null 2>&1; then
        ACTUAL=$(shasum -a 256 "$TMP/node.tar.gz" | awk '{print $1}')
      else
        ACTUAL=$(sha256sum "$TMP/node.tar.gz" | awk '{print $1}')
      fi
      if [ -z "$EXPECTED" ] || [ "$ACTUAL" != "$EXPECTED" ]; then
        echo "${RED}  ✗ Node download failed its SHA-256 verification.${OFF}"
        rm -rf "$TMP"
        exit 1
      fi
      tar -xzf "$TMP/node.tar.gz" -C "$TMP"
      mkdir -p "$GRIDIRON_RUNTIME_ROOT"
      rm -rf "$GRIDIRON_RUNTIME_ROOT/node"
      mv "$TMP/node-${NODE_VER}-${PLAT}-${ARCH}" "$GRIDIRON_RUNTIME_ROOT/node"
      export PATH="$GRIDIRON_RUNTIME_ROOT/node/bin:$PATH"
      hash -r
      echo "${GREEN}  ✓${OFF} Installed Node ${NODE_VER} privately (~/.gridiron/node)"
    fi
    rm -rf "$TMP"
  fi

  if ! node_ok; then
    echo ""
    echo "${RED}  ✗ Could not get a working Node.js automatically.${OFF}"
    echo "    This usually means no internet connection, or a network that blocks"
    echo "    nodejs.org. Opening the download page — grab the LTS installer, run"
    echo "    it, then double-click ${BOLD}Install Gridiron HQ${OFF} again."
    echo ""
    open "https://nodejs.org/en/download" 2>/dev/null || xdg-open "https://nodejs.org/en/download" 2>/dev/null || true
    exit 1
  fi
fi
echo "${GREEN}  ✓${OFF} Node $(node -v)"

# Internal packaging smoke test: verify the zero-prerequisite Node bootstrap
# without downloading every npm package or creating user data.
if [ "${GRIDIRON_BOOTSTRAP_ONLY:-0}" = "1" ]; then
  exit 0
fi

exec node scripts/install.mjs "$@"
