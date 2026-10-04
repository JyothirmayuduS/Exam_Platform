#!/bin/bash
set -e
RUN_ID=37121736297
echo "Waiting for GitHub Actions run $RUN_ID to complete..."
gh run watch $RUN_ID --exit-status || true
echo "Run completed. Downloading artifact..."
rm -rf ~/Downloads/latest-lockdown-artifact
gh run download $RUN_ID --dir ~/Downloads/latest-lockdown-artifact
echo "Artifact downloaded. Extracting..."
cd ~/Downloads/latest-lockdown-artifact
APP_DMG=$(find . -name "*.dmg" | head -n 1)
if [ -z "$APP_DMG" ]; then
    echo "No DMG found in artifact!"
    exit 1
fi
echo "Found DMG: $APP_DMG"
hdiutil attach "$APP_DMG"
echo "Deleting old app..."
rm -rf "/Applications/Vignan Exam Browser.app"
echo "Copying new app..."
cp -R "/Volumes/Vignan Exam Browser/Vignan Exam Browser.app" /Applications/
hdiutil detach "/Volumes/Vignan Exam Browser"
echo "Done!"
