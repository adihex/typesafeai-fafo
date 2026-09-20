#!/usr/bin/env bash
set -euo pipefail

# Install wkb to ~/.local/bin. Search, query, and indexing require either a
# checksum-pinned vendored SOMA archive or an explicit executable override.
#
# Usage:
#   bash tools/wikikb-local/install.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_DIR="${WKB_INSTALL_DIR:-$HOME/.local/bin}"
SOMA_ARCHIVE=""
case "$(uname -s):$(uname -m)" in
    Linux:x86_64|Linux:amd64) SOMA_ARCHIVE="$REPO_ROOT/vendor/soma/soma-v0.3.0-linux-x86_64.tar.gz" ;;
    Linux:arm64|Linux:aarch64) SOMA_ARCHIVE="$REPO_ROOT/vendor/soma/soma-v0.3.0-linux-arm64.tar.gz" ;;
    Darwin:arm64|Darwin:aarch64) SOMA_ARCHIVE="$REPO_ROOT/vendor/soma/soma-v0.3.0-macos-arm64.tar.gz" ;;
    MINGW*:x86_64|MSYS*:x86_64|CYGWIN*:x86_64) SOMA_ARCHIVE="$REPO_ROOT/vendor/soma/soma-v0.3.0-windows-x86_64.zip" ;;
    MINGW*:arm64|MINGW*:aarch64|MSYS*:arm64|MSYS*:aarch64|CYGWIN*:arm64|CYGWIN*:aarch64) SOMA_ARCHIVE="$REPO_ROOT/vendor/soma/soma-v0.3.0-windows-arm64.zip" ;;
esac

echo "Installing wkb..."

if [ -n "${WIKIKB_SOMA_BIN:-}" ]; then
    if [ ! -x "$WIKIKB_SOMA_BIN" ]; then
        echo "ERROR: WIKIKB_SOMA_BIN is not executable: $WIKIKB_SOMA_BIN" >&2
        exit 1
    fi
elif [ -z "$SOMA_ARCHIVE" ] || [ ! -f "$SOMA_ARCHIVE" ]; then
    echo "ERROR: No vendored SOMA 0.3.0 binary for $(uname -s)/$(uname -m)." >&2
    echo "Set WIKIKB_SOMA_BIN to an approved SOMA executable." >&2
    exit 1
fi

if ! command -v node &>/dev/null; then
    echo "ERROR: Node.js 22+ required."
    exit 1
fi
node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 22 ? 0 : 1)' || {
    echo "ERROR: Node.js 22+ required. Found: $(node --version)"
    exit 1
}
echo "  Node: $(node --version)"

if [ ! -d "$REPO_ROOT/node_modules" ]; then
    echo "  Installing TypeScript dependencies..."
    npm ci --prefix "$REPO_ROOT"
fi

echo "  Building TypeScript CLI..."
npm run --prefix "$REPO_ROOT" build:wkb

mkdir -p "$INSTALL_DIR"
WRAPPER="$INSTALL_DIR/wkb"
cat > "$WRAPPER" << WRAPPER_EOF
#!/usr/bin/env bash
exec "$SCRIPT_DIR/wkb" "\$@"
WRAPPER_EOF
chmod +x "$WRAPPER"

if [ -n "${WIKIKB_SOMA_BIN:-}" ]; then
    echo "  SOMA: executable override $WIKIKB_SOMA_BIN"
elif [ -n "$SOMA_ARCHIVE" ] && [ -f "$SOMA_ARCHIVE" ]; then
    echo "  SOMA: vendored 0.3.0 binary available (extracted on first index)"
fi

echo ""
echo "Installed: $WRAPPER"

if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    echo ""
    echo "Add to your shell profile:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
fi

echo ""
echo "Quick start:"
echo "  export WIKIKB_GITHUB_TOKEN=\$(gh auth token)"
echo "  wkb add mykb owner/repo"
echo "  wkb mykb index"
echo "  wkb mykb search \"your query\""
echo "  wkb --help"
