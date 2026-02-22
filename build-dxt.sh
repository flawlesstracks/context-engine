#!/bin/bash
# build-dxt.sh — Build the Context Engine Desktop Extension

set -e

# Always run from the repo root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building Context Engine DXT..."

# 1. Create clean build directory
rm -rf dist/dxt-build
mkdir -p dist/dxt-build/server

# 2. Copy manifest
cp dxt/manifest.json dist/dxt-build/

# 3. Copy server
cp dxt/server/index.js dist/dxt-build/server/

# 4. Copy icon if exists
cp dxt/icon.png dist/dxt-build/ 2>/dev/null || echo "No icon.png found, skipping"

# 5. Install production dependencies
cd dist/dxt-build
cat > package.json << 'EOF'
{
  "name": "context-engine-dxt",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
EOF
npm install --production 2>&1
cd ../..

# 6. Pack as .dxt (ZIP format)
if command -v dxt &> /dev/null; then
  cd dist/dxt-build
  dxt pack
  mv *.dxt ../context-engine.dxt
  cd ../..
  echo "Built with dxt CLI: dist/context-engine.dxt"
elif command -v mcpb &> /dev/null; then
  cd dist/dxt-build
  mcpb pack
  mv *.mcpb ../context-engine.mcpb
  cd ../..
  echo "Built with mcpb CLI: dist/context-engine.mcpb"
else
  # Fallback: manual zip
  cd dist/dxt-build
  zip -r ../context-engine.dxt manifest.json server/ node_modules/ package.json
  cd ../..
  echo "Built manually: dist/context-engine.dxt"
fi

echo "Size: $(du -sh dist/context-engine.dxt 2>/dev/null || du -sh dist/context-engine.mcpb 2>/dev/null || echo 'unknown')"
echo "Done!"
