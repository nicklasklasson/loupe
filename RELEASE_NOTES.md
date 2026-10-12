Mac installer for Loupe 0.3.0. Drag Loupe to Applications (Administrator Mode), then Privacy & Security › **Open Anyway**. This version needs the Screen Recording (and Accessibility) permission once more; from now on it survives updates.

**Capture windows close themselves**

- **Copy closes the window.** The image is on your clipboard, so the window gets out of the way. Switch it off with *Close capture after Copy* in the home window.
- **Untouched capture windows close on their own** after sitting in the background for 2 minutes (choose 30 seconds, 10 minutes or never under *Close untouched captures after*). A window you're looking at, or one you've annotated, is never closed by the timer.
- **Save / Don't Save / Keep Editing** when you close a capture with unsaved annotations, with Save as the default. Before, there was no Save button in that question.
- **Close all capture windows** in the tray and Capture menus.

**Updates**

- **Check for Updates…** in the Loupe menu and the tray menu. Loupe also looks once a day and notifies you once per new version. Installing downloads the dmg, checks it's signed with the Loupe certificate, swaps the app and restarts. Needs Administrator Mode.
- Every build is now signed with the same Loupe certificate, so macOS keeps the permissions you've granted across updates. Builds are made by GitHub Actions; see the README.
