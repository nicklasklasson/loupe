# Loupe

A desktop screen capture, annotation and screen recording tool, built with Electron. It runs on Windows, macOS and Linux (X11).

## Installing on a Mac

Before you start (PaymentIQ Macs): request Administrator Mode in the PaymentIQ Self Service app. Actions like Copying to Applications, the xattr command, and later updates all need it.
You don’t need Node.js or npm to use Loupe. Download the installer, drag it to Applications, and run one Terminal command the first time to get past the malware warning.

1. Download `Loupe-<version>-universal.dmg` from the [Releases page](https://github.com/nicklasklasson/loupe/releases/latest). It runs on Apple Silicon and Intel Macs.
2. Open the dmg and drag Loupe to Applications. On a PaymentIQ Mac this needs **Administrator Mode**: request it in the PaymentIQ Self Service app first.
3. The first launch is blocked with *"Apple could not verify Loupe is free of malware"*. Click **Done**, then go to System Settings > Privacy & Security and click **Open Anyway**. If that button doesn't appear, run this in Terminal instead (also needs Administrator Mode):

   ```
   xattr -dr com.apple.quarantine /Applications/Loupe.app
   ```

4. Allow **Screen Recording** for Loupe when asked, and **Accessibility** if you use step capture, then restart it. From 0.3.0 on these permissions survive updates, because every version is signed with the same Loupe certificate.

**Updates.** Loupe checks GitHub once a day and tells you when there's a newer version (switch this off in the updates window if you like). **Check for Updates…** in the Loupe menu and the tray menu shows what's new and installs it: Loupe downloads the dmg, checks it's signed with the same Loupe certificate, swaps itself out and restarts. Installing needs Administrator Mode, like the first install. The warning in step 3 doesn't come back for updates Loupe installs itself.

**Coming from 0.2.x?** Drag the new Loupe over the old one (Replace), do step 3, then open Screen Recording, select the old Loupe entry, remove it with the **−** button, and allow Loupe again when it asks (quit and reopen once). The setting looks switched on already, but that entry belongs to the old build. Same for Accessibility if you use step capture. This is a one-time thing: later versions arrive through Check for Updates… and keep the permissions.

## Shortcuts

| Action | Shortcut |
|---|---|
| Capture a region | `Alt+Shift+1` (also `PrintScreen` on Windows/Linux, if the OS doesn't reserve it) |
| Capture a window | `Alt+Shift+2` |
| Capture the full screen | `Alt+Shift+3` |
| Record video | `Alt+Shift+R` |
| Copy text from the screen | `Alt+Shift+T` |
| Step capture | `Alt+Shift+S` |

**Timer.** Under each action in the Loupe window there's a **Timer** switch; the same switches are under **Timer** in the menu bar/tray menu. With it on, Loupe waits before capturing, so you can open a menu, hover over something or click something first. **Timer length** (3, 5 or 10 seconds) applies to all of them. For **Region** and **Copy text**, you choose the area first; then the countdown runs with the area outlined, and the area is captured as it looks when the countdown ends. **Full screen** counts down before capturing; **Window** counts down after you pick the window. Under **Record video** the switch is the 3-second countdown before recording starts (on by default). **Esc** cancels a countdown. Step capture has no timer, because it captures the moment of each click.

On macOS, `Alt` is the `⌥` Option key. You can change the shortcuts in the `HOTKEYS` object at the top of `main.js`. If another app already uses a shortcut, the home window shows it crossed out.

## What it does

**Capture.** When you capture a region, the screen freezes and dims. Drag to select an area. A magnifier next to the cursor shows the pixels under it, the coordinates and the colour. A single click or `Enter` captures the whole screen, and `Esc` cancels. Window capture lets you pick any open window from a gallery.

Every capture is saved as a PNG to your library folder, copied to your clipboard and opened in the editor. The library folder is `Pictures/Loupe` unless you pick another one with **Change folder…** in the home window.

**Editor.** These are the tools, with their shortcut keys:

- `V` Select: click an annotation to move it, drag its handles to resize it, or restyle it from the top bar. Arrow keys nudge the selection and `Delete` removes it.
- `A` Arrow and `L` Line: hold `Shift` to snap to 45°.
- `R` Rectangle and `E` Ellipse: outline or filled. Hold `Shift` for a square or circle.
- `T` Text: plain text with a legibility halo, or filled callout labels. Double-click text to edit it, and press `Ctrl+Enter` or `Esc` to finish.
- `S` Numbered steps: these count up automatically, and you can set the next number yourself.
- `H` Highlighter.
- `B` Blur: pixelates whatever is under the box, such as emails, card numbers or names.
- `C` Crop: drag over the part to keep, then press `Enter`.

Annotations can go past the edge of the screenshot. You can even start drawing in the dark area around it, and the canvas grows to fit them, like in Snagit, so nothing is cut off. The extra area is transparent: it shows as a checkerboard in the editor, stays transparent when you copy or save as PNG, and becomes white in a JPEG. Cropping cuts through annotations that cross the crop edge.

The editor also supports undo and redo (`Ctrl+Z`, `Ctrl+Shift+Z`) and zoom (`Ctrl+0` to fit, `Ctrl+1` for 100%, or `Ctrl` + mouse wheel). Hold `Space` and drag to pan. `Ctrl+C` copies the annotated image, `Ctrl+S` saves over the capture in the library, and `Ctrl+Shift+S` saves a PNG or JPEG anywhere. Opening an image from outside the library never overwrites it, because Save makes a copy.

**Capture windows close themselves.** Every capture is already in your library and on your clipboard, so an open capture window rarely needs to stay around:

- **Copy closes the window.** You copy because you're off to paste the image somewhere; the window gets out of the way. Switch this off with **Close capture after Copy** in the home window if you prefer.
- **Untouched windows close on their own** after they have sat in the background for a while: 2 minutes unless you pick 30 seconds, 10 minutes or never under **Close untouched captures after**. A window you're looking at is never closed, and the timer restarts whenever you come back to it.
- **Edited captures are never closed by the timer.** When you close one yourself (or copy from it), Loupe asks **Save / Don't Save / Keep Editing**. Save writes the annotated capture to your library (a copy, for images opened from elsewhere); Don't Save keeps the original as it was.
- **Close all capture windows** in the tray and Capture menus closes everything at once, asking about unsaved changes along the way.

**Recording.** Pick a screen, a window, or **Select an area…**. You can include your microphone, and on Windows, computer sound. A small control bar counts down 3 seconds, then shows the timer with Pause, Stop and Discard buttons. When you record an area, a dashed outline marks it. Recordings are saved to the library folder as MP4 (H.264) when the system can record it, which is the case on current macOS and Windows, and as WebM otherwise.

**Library.** The home window shows every capture and recording in the library folder, newest first. **Change folder…** picks where new captures and recordings are saved, and **Use default** goes back to `Pictures/Loupe`. Existing files stay where they are. If the chosen folder can't be reached, such as an unplugged drive, Loupe saves to `Pictures/Loupe` and says so. Click one to open it. When you hover over an image tile you can copy it to the clipboard, pin it, show it in its folder or move it to the trash. The library also has **Open image…** and **Paste image**, which opens the clipboard image in the editor.

**Copy text (OCR).** Press the shortcut and drag over any text on screen. Loupe reads it, copies it to the clipboard and shows it in a small window where you can correct it and copy again. **Copy text** in the editor reads the whole image. Recognition runs entirely on the computer, with English and Swedish built in (`assets/ocr`), so nothing is uploaded.

**Pin.** **Pin** in the editor, on image tiles in the library, or in a pinned capture's own menu keeps a capture floating above other windows. Drag it to move it and scroll to zoom. Double-click or press `Esc` to close it. Right-click for copy, copy text, opacity, actual size and close all. **Close all pinned captures** is also in the tray menu.

**Step capture.** Press the shortcut, then work through a task: every left click becomes a numbered screenshot showing the screen just before the click, with a ring where you clicked. **Pause** stops capturing for a moment, and **Done** opens the guide. There you name the guide, describe each step, reorder or delete steps, and click a screenshot to annotate, blur or crop it in the editor. **Export PDF…** and **Export web page…** produce a document with every step. Guides are saved as folders in the library and appear there with a "Guide" badge. On macOS, step capture needs **Accessibility** permission (System Settings > Privacy & Security > Accessibility), because Loupe has to notice clicks in other apps. It only listens while a step capture runs and never records typing.

**Camera bubble.** Tick **Show camera** before recording and a round camera view appears on screen, so it's part of screen and area recordings. Drag it to move it; hover for size and hide buttons. A window recording only captures that window, so the bubble isn't in it. macOS asks for camera access the first time.

**Video editor.** A recording opens in the video editor when you stop it; you can also click any video in the library. Choose a part to remove by dragging on the timeline, with **Set start here** / **Set end here** (`I` / `O`) at the playhead, or by typing times in **From** and **To** (for example `0:12` and `0:18.5`, then Enter). **Remove this part** cuts it out, and you can remove several parts. Playback skips removed parts so you can check the result. **Save as new video** writes `… (edited).mp4` next to the original, which stays unchanged. Saving normally takes seconds. If a video can't be processed that way, Loupe plays the kept parts back and re-records them instead, which takes as long as the result.

## Limitations

- Saving flattens the annotations into the PNG. There is no layered project format like Snagit's `.snagx`, so you can't move annotations after saving and reopening. Use **Save as…** if you want to keep the untouched original.
- If a system can't record MP4, recordings fall back to WebM (VP9 or VP8). Chrome, Firefox and VLC play those, and `ffmpeg -i in.webm out.mp4` converts them.
- Computer sound capture works on Windows only. That's a Chromium limitation. On macOS you'd need a loopback driver such as BlackHole, selected as the microphone.
- Window capture uses the OS window thumbnail, so it can't capture minimized windows. There is no scrolling or panoramic capture, and no click-a-window-in-the-overlay mode.
- On Linux, Wayland sessions limit screen capture. X11 works best.
- On most systems the recording bar and area outline are kept out of the video. On older Windows builds (before 10 version 2004) the recording bar can still show up in full-screen recordings.

## For developers

The rest of this page is about building and changing Loupe.

### Running from source

Only needed if you want to change Loupe. To use it, install the dmg instead (see the top of this page).

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. Clone the repository, open a terminal in it and run:

```
npm install
npm start
```

Loupe opens its main window and puts an icon in the system tray (the menu bar on macOS). Closing the window keeps Loupe running in the tray, so the shortcuts keep working. To quit, use **Quit Loupe** in the tray menu.

#### macOS permission

The first capture asks for Screen Recording permission. Turn it on in **System Settings > Privacy & Security > Screen Recording**, then quit and restart Loupe. While you run it with `npm start`, the entry is called **Electron**.

### Releasing a new version

Nobody builds Loupe on their own Mac: GitHub Actions builds the dmg and attaches it to a release.

1. Raise `version` in `package.json` and write `RELEASE_NOTES.md` (it becomes the release's notes).
2. Run `./release.sh`. It commits, pushes, tags `v<version>`, waits for the build (about 10 minutes), says whether the build was signed with the Loupe certificate, then downloads the dmg to `~/Downloads` and opens it. Needs git and the GitHub CLI (`gh`), nothing else.

Running it again for a version that was never released moves the tag and rebuilds, so a failed build isn't a problem.

**Signing certificate (one-time).** Run `bash build/make-signing-cert.sh` once. It creates the self-signed "Loupe Signing" certificate, stores it as repository secrets (`LOUPE_SIGNING_P12`, `LOUPE_SIGNING_PASSWORD`) and keeps a backup in `~/Documents/Loupe signing certificate`; move that to 1Password. GitHub can't show secrets again, so the backup is the only copy. The certificate is what lets macOS keep the Screen Recording and Accessibility permissions across updates and lets Loupe trust its own updates. It doesn't remove the first-launch warning; only a paid Apple Developer ID with notarization does that.

**Windows:** `npm run dist:win` on a Windows PC builds `dist/Loupe Setup <version>.exe`. SmartScreen shows "Windows protected your PC"; click **More info**, then **Run anyway**. Windows builds aren't signed and don't self-update.

See `docs/ENGINEERING.md` for how the pipeline works and what to check when it doesn't.

### Project layout

```
main.js          main process: tray, shortcuts, capture pipeline, windows, file saving
preload.js       the small API the pages are allowed to call
src/home.*       main window with capture actions and the library
src/overlay.*    frozen-screen region selector with the magnifier
src/picker.*     window/screen chooser for capture and recording
src/editor.*     annotation editor
src/recorder.*   recording control bar
src/text.*       text from screen (OCR) result window
src/pin.*        pinned captures
src/camera.*     camera bubble
src/steps.*      step capture control bar
src/guide.*      step guide editor and export
src/video.*      video editor; src/videocut.js does the cutting
src/update.*     Check for Updates window; src/updater.js downloads, verifies and installs
ocr.js           offline text recognition (main process)
assets/          app and tray icons
build/           signing hook, packaging check, certificate and Electron setup scripts
release.sh       publishes the version in package.json via GitHub Actions
```
