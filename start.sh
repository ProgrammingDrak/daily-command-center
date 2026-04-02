#!/bin/bash
# Daily Command Center — Mac/Linux launcher

PORT=${PORT:-8090}

# Check for Node.js
if ! command -v node &> /dev/null; then
  echo "Node.js is not installed. Download it at https://nodejs.org"
  exit 1
fi

# Install/update dependencies
echo "Installing dependencies..."
npm install --before="$(date -d '7 days ago' +%Y-%m-%dT00:00:00.000Z 2>/dev/null || date -v-7d +%Y-%m-%dT00:00:00.000Z)"

echo ""
echo "Starting Daily Command Center on http://localhost:$PORT"
echo "Press Ctrl+C to stop."
echo ""

PORT=$PORT node server.js
