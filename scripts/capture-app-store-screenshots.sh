#!/bin/bash
# ==============================================================================
# iOS Simulator Screenshot Capture Helper
#
# Requirements for App Store:
# - 6.9" display (iPhone 16 Pro Max): 1320 x 2868 pixels
# - 6.7" display (iPhone 15 Pro Max): 1290 x 2796 pixels
# ==============================================================================

set -e

BUNDLE_ID="com.netraops.guard"
SCREENS=("01_login" "02_dashboard" "03_clock_in" "04_active_shift_map" "05_report_capture" "06_report_submitted" "07_report_history")
DEVICES=("iPhone 16 Pro Max" "iPhone 15 Pro Max")
OUTPUT_DIR="$(pwd)/screenshots"

echo "======================================================================"
echo "Netra App Store Screenshot Capture"
echo "======================================================================"
echo "This script will boot simulators and guide you through capturing"
echo "screenshots for the App Store."
echo ""
echo "Ensure you have built and installed the app on the simulators first."
echo "======================================================================"

mkdir -p "$OUTPUT_DIR"

for DEVICE in "${DEVICES[@]}"; do
  echo ""
  echo ">>> Preparing device: $DEVICE"
  
  # Find device ID
  DEVICE_ID=$(xcrun simctl list devices available | grep "$DEVICE" | head -1 | grep -oE '[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}')
  
  if [ -z "$DEVICE_ID" ]; then
    echo "Error: Could not find available simulator for $DEVICE. Please create one in Xcode."
    continue
  fi

  # Boot device if not already booted
  STATE=$(xcrun simctl list devices | grep "$DEVICE_ID" | grep -o 'Booted' || true)
  if [ "$STATE" != "Booted" ]; then
    echo "Booting simulator $DEVICE ($DEVICE_ID)..."
    xcrun simctl boot "$DEVICE_ID" || true
  fi
  
  # Open simulator app
  open -a Simulator

  echo "Launching app ($BUNDLE_ID) on $DEVICE..."
  xcrun simctl launch "$DEVICE_ID" "$BUNDLE_ID" || echo "Warning: App might not be installed. Please install it on this simulator."

  DEVICE_DIR="$OUTPUT_DIR/$(echo "$DEVICE" | tr ' ' '_')"
  mkdir -p "$DEVICE_DIR"

  for SCREEN in "${SCREENS[@]}"; do
    echo ""
    echo "--------------------------------------------------------"
    echo "ACTION REQUIRED: Navigate to the [ $SCREEN ] screen."
    echo "--------------------------------------------------------"
    read -p "Press ENTER when ready to capture $SCREEN on $DEVICE..."

    FILENAME="$DEVICE_DIR/${SCREEN}.png"
    echo "Capturing..."
    xcrun simctl io "$DEVICE_ID" screenshot "$FILENAME"
    echo "Saved: $FILENAME"
  done

  echo ""
  echo "Finished capturing $DEVICE."
done

echo ""
echo "======================================================================"
echo "All captures complete!"
echo "Saved to: $OUTPUT_DIR"
echo "======================================================================"
