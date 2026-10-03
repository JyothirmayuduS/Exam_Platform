#!/bin/bash
echo "Closing existing VignanExam..."
pkill -f VignanExam
sleep 1
echo "Removing old app..."
rm -rf /Applications/VignanExam.app
echo "Installing new app..."
cp -R src-tauri/target/release/bundle/macos/Vignan\ Exam\ Browser.app /Applications/VignanExam.app
echo "Done!"
