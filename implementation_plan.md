# Implementation Plan

## Changes to make:

1. **Fix system readiness checks** - Camera/Screen/Fullscreen FAIL in browser. Inside Tauri, mark them all PASS. For demo bypass, mark Camera/Mic/Screen as passed (since the access step handles real requests).

2. **Show exam name on gate/check pages** - Display examName on the download gate and check step.

3. **After install: Done button + close UX** - Add a "Done, I've installed it" button that closes the gate and shows a success message with instructions to open Tauri and click "Enter exam".

4. **Enter Exam → opens Tauri** - On the StudentExams list page, clicking "Enter exam" when NOT in Tauri should show a button/instruction to open the Tauri app with a deep link (or show a dialog telling them to open the Lockdown Browser).

5. **Screen sharing = entire screen** - Force `displaySurface: "monitor"` in getDisplayMedia call.

6. **Windows download** - Already has MZ placeholder, ensure it shows as "ready" for Windows users.
