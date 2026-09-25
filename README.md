# Loupe

A desktop screen capture, annotation and screen recording tool, built with Electron. It runs on Windows, macOS and Linux (X11).

## Get it running

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. Unzip this folder, open a terminal in it and run:

```
npm install
npm start
```

Loupe opens its main window and puts an icon in the system tray (the menu bar on macOS). Closing the window keeps Loupe running in the tray, so the shortcuts keep working. To quit, use **Quit Loupe** in the tray menu.

To build an installer to share with colleagues, run `npm run dist:mac` (a `.dmg`) or `npm run dist:win` (a `.exe` installer). The output goes to `dist/`. See "Sharing Loupe" below.

### macOS permission

The first capture asks for Screen Recording permission. Turn it on in **System Settings > Privacy & Security > Screen Recording**, then quit and restart Loupe. While you run it with `npm start`, the entry is called **Electron**.

## Shortcuts

| Action | Shortcut |
|---|---|
| Capture a region | `Alt+Shift+1` (also `PrintScreen` on Windows/Linux, if the OS doesn't reserve it) |
| Capture a window | `Alt+Shift+2` |
| Capture the full screen | `Alt+Shift+3` |
| Record video | `Alt+Shift+R` |

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

The editor also supports undo and redo (`Ctrl+Z`, `Ctrl+Shift+Z`) and zoom (`Ctrl+0` to fit, `Ctrl+1` for 100%, or `Ctrl` + mouse wheel). Hold `Space` and drag to pan. `Ctrl+C` copies the annotated image, `Ctrl+S` saves over the capture in the library, and `Ctrl+Shift+S` saves a PNG or JPEG anywhere. Opening an image from outside the library never overwrites it, because Save makes a copy.

**Recording.** Pick a screen, a window, or **Select an area…**. You can include your microphone, and on Windows, computer sound. A small control bar counts down 3 seconds, then shows the timer with Pause, Stop and Discard buttons. When you record an area, a dashed outline marks it. Recordings are saved to the library folder as MP4 (H.264) when the system can record it, which is the case on current macOS and Windows, and as WebM otherwise.

**Library.** The home window shows every capture and recording in the library folder, newest first. **Change folder…** picks where new captures and recordings are saved, and **Use default** goes back to `Pictures/Loupe`. Existing files stay where they are. If the chosen folder can't be reached, such as an unplugged drive, Loupe saves to `Pictures/Loupe` and says so. Click one to open it. When you hover over a tile you can show it in its folder or move it to the trash. The library also has **Open image…** and **Paste image**, which opens the clipboard image in the editor.

## Limitations

- Saving flattens the annotations into the PNG. There is no layered project format like Snagit's `.snagx`, so you can't move annotations after saving and reopening. Use **Save as…** if you want to keep the untouched original.
- If a system can't record MP4, recordings fall back to WebM (VP9 or VP8). Chrome, Firefox and VLC play those, and `ffmpeg -i in.webm out.mp4` converts them.
- Computer sound capture works on Windows only. That's a Chromium limitation. On macOS you'd need a loopback driver such as BlackHole, selected as the microphone.
- Window capture uses the OS window thumbnail, so it can't capture minimized windows. There is no scrolling or panoramic capture, and no click-a-window-in-the-overlay mode.
- On Linux, Wayland sessions limit screen capture. X11 works best.
- On most systems the recording bar and area outline are kept out of the video. On older Windows builds (before 10 version 2004) the recording bar can still show up in full-screen recordings.

## Sharing Loupe

- **Mac:** `npm run dist:mac` builds `dist/Loupe-0.1.0-universal.dmg`, which runs on Apple Silicon and Intel Macs.
- **Windows:** `npm run dist:win` builds `dist/Loupe Setup 0.1.0.exe`. Build it on a Windows PC for the most reliable result.

Bump `version` in `package.json` before each new build you send out.

Unsigned builds work, but each colleague has to approve them once:

- **Mac:** open the `.dmg` and drag Loupe to Applications. The first launch is blocked. Go to System Settings > Privacy & Security, click **Open Anyway**, then allow Screen Recording for **Loupe** and restart it.
- **Windows:** SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.

To remove those warnings, sign the builds:

- **Mac:** you need an Apple Developer account and a "Developer ID Application" certificate in your keychain. Set `"notarize": true` under `build.mac` in `package.json`. Then set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` in your environment and run `npm run dist:mac`.
- **Windows:** you need a code-signing certificate. See the electron-builder code signing docs.

## Project layout

```
main.js          main process: tray, shortcuts, capture pipeline, windows, file saving
preload.js       the small API the pages are allowed to call
src/home.*       main window with capture actions and the library
src/overlay.*    frozen-screen region selector with the magnifier
src/picker.*     window/screen chooser for capture and recording
src/editor.*     annotation editor
src/recorder.*   recording control bar
assets/          app and tray icons
```
