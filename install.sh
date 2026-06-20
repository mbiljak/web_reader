#!/bin/bash
# Registers the Web Reader native messaging host with Firefox so the extension
# can drive the macOS `say` command (premium voices, pause/resume).
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
HOST="$DIR/native/web_reader_host.py"

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "ERROR: python3 not found. Install it (e.g. 'xcode-select --install') and re-run." >&2
  exit 1
fi

# Firefox launches the host with a minimal PATH that won't include version-manager
# pythons (mise/pyenv/homebrew). Generate a launcher that hard-codes the absolute
# interpreter path so it works regardless of Firefox's environment.
LAUNCHER="$DIR/native/launch.sh"
cat > "$LAUNCHER" <<EOF
#!/bin/bash
exec "$PY" "$HOST" "\$@"
EOF
chmod +x "$LAUNCHER" "$HOST"

TARGET="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
mkdir -p "$TARGET"

cat > "$TARGET/com.webreader.host.json" <<EOF
{
  "name": "com.webreader.host",
  "description": "Web Reader macOS say bridge",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_extensions": ["web-reader@local"]
}
EOF

echo "✓ Native host registered."
echo "  interpreter: $PY"
echo "  launcher:    $LAUNCHER"
echo "  manifest:    $TARGET/com.webreader.host.json"
echo
echo "IMPORTANT: fully quit and reopen Firefox so it picks up the host,"
echo "then reload the add-on in about:debugging."
