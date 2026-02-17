#!/bin/bash
# Prolink Stream Overlay — Quick Install
# Downloads Node.js if needed, installs dependencies, and runs

set -e

echo "🎧 Prolink Stream Overlay — Setup"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "⚠️  Node.js not found. Please install it from https://nodejs.org"
    echo "   (Recommended: LTS version)"
    exit 1
fi

NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 18 ]; then
    echo "⚠️  Node.js v18+ required (found v$(node -v))"
    echo "   Please update: https://nodejs.org"
    exit 1
fi

echo "✅ Node.js $(node -v) found"

# Install dependencies
echo "📦 Installing dependencies..."
npm install --production 2>&1 | tail -1

echo ""
echo "✅ Ready! Run with:"
echo ""
echo "   node server.js"
echo ""
echo "Then open http://localhost:4455/overlay in your browser or OBS."
echo ""
