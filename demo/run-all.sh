#!/bin/bash
# HearthNet Demo — Run all three scenes in sequence
# Usage: bash run-all.sh [--reset]
#
# --reset: Re-initialize the ground-truth Git repo before running

set -e
cd "$(dirname "$0")/.."

REPO="groundplane-state"

if [ "$1" = "--reset" ]; then
  echo "═══ Resetting ground-truth repo ═══"
  rm -rf "$REPO"
  echo "  Repo deleted. Dewey will re-initialize on first event."
  echo ""
fi

echo "═══════════════════════════════════════════════════════"
echo " HearthNet Demo — Full Sequence"
echo " Scene 1: Intent-Driven Coordination (WFH mode)"
echo " Scene 2: Conflict Resolution (wind-down vs WFH)"
echo " Scene 3: Freshness + Lease Verification (crash replay)"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Prerequisites:"
echo "  1. MQTT broker running (mosquitto on port 1883)"
echo "  2. Dewey librarian running (npm run librarian)"
echo ""
echo "Press Enter to start Scene 1, or Ctrl+C to abort..."
read -r

echo ""
echo "═══ SCENE 1 ═══"
node demo/scene1-coordinated-actuation.js

echo "Press Enter for Scene 2..."
read -r

echo "═══ SCENE 2 ═══"
node demo/scene2-conflict-resolution.js

echo "Press Enter for Scene 3..."
read -r

echo "═══ SCENE 3 ═══"
node demo/scene3-freshness-verification.js

echo ""
echo "═══════════════════════════════════════════════════════"
echo " ALL SCENES COMPLETE"
echo ""
echo " Git log (last 20 events):"
cd "$REPO" && git log --oneline -20 && cd ..
echo ""
echo " Lease log:"
cat "$REPO/leases/"*.jsonl 2>/dev/null || echo "  (no lease logs yet)"
echo "═══════════════════════════════════════════════════════"
