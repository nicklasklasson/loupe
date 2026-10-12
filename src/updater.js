// Updates: find out whether GitHub has a newer Loupe, download it, check it's signed with the
// same Loupe certificate as this one, and replace this copy in Applications.
//
// Network: a HEAD request to github.com/<repo>/releases/latest (the redirect says which version
// is newest), the release notes from GitHub's API when you look at an update, and the dmg when
// you install it. Nothing about you or your captures is sent.

const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** 1 if a > b, -1 if a < b, 0 if equal. "0.1.12" > "0.1.9". */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** GitHub's markdown release notes as plain, readable text. */
function plainNotes(markdown) {
  return String(markdown || '')
    .replace(/\r/g, '')
    .replace(/```[a-z]*\n?/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

class Updater extends EventEmitter {
  constructor({ app, fetchImpl, repo, cacheDir }) {
    super();
    this.app = app;
    this.fetch = fetchImpl;
    this.repo = repo;
    this.cacheDir = cacheDir;
    this.current = app.getVersion();
    this.state = { phase: 'idle', current: this.current, latest: null, available: false, checkedAt: 0, error: null, received: 0, total: 0, notes: null };
    this.controller = null;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  /** The .app bundle this Loupe runs from, or null when running from source. */
  bundlePath() {
    if (!this.app.isPackaged) return null;
    const exe = this.app.getPath('exe'); // …/Loupe.app/Contents/MacOS/Loupe
    return path.resolve(exe, '..', '..', '..');
  }

  /** Whether this copy can replace itself: installed in a folder we may write to. */
  canInstall() {
    const bundle = this.bundlePath();
    if (!bundle) return { ok: false, reason: 'source', message: 'Loupe is running from source, so it can’t update itself. Use release.sh.' };
    if (bundle.startsWith('/Volumes/')) return { ok: false, reason: 'dmg', message: 'Loupe is running from the dmg. Drag it to Applications first.' };
    const dir = path.dirname(bundle);
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      const probe = path.join(dir, `.loupe-write-test-${process.pid}`);
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      return { ok: true, bundle };
    } catch (_) {
      return { ok: false, reason: 'admin', message: 'Installing needs Administrator Mode. Request it in the PaymentIQ Self Service app, then click Install again.' };
    }
  }

  /**
   * Which version is newest on GitHub? github.com/<repo>/releases/latest redirects to the newest
   * release's page. Some networking stacks don't report the address after a redirect, so the
   * version is also read from the page itself, and as a last resort from GitHub's API.
   */
  async check() {
    if (this.state.phase === 'downloading' || this.state.phase === 'installing') return this.state;
    this.set({ phase: 'checking', error: null });
    const tagRe = new RegExp(`/${this.repo.replace('/', '\\/')}/releases/tag/v?([0-9][0-9A-Za-z.-]*)`);
    try {
      let latest = null;
      let status = 0;
      try {
        const response = await this.fetch(`https://github.com/${this.repo}/releases/latest`, { redirect: 'follow' });
        status = response.status;
        latest = (tagRe.exec(response.url || '') || [])[1] || null;
        if (!latest && response.ok) latest = (tagRe.exec(await response.text()) || [])[1] || null;
      } catch (err) {
        if (!this.state.latest) status = -1;
      }
      if (!latest) {
        const api = await this.fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
        if (api.ok) latest = String((await api.json()).tag_name || '').replace(/^v/, '') || null;
        else if (api.status === 404) throw new Error('no releases found on GitHub');
        else status = api.status;
      }
      if (!latest) throw new Error(status === -1 ? 'GitHub couldn’t be reached' : `GitHub didn’t say which version is newest (${status})`);
      const available = compareVersions(latest, this.current) > 0;
      this.set({ phase: 'idle', latest, available, checkedAt: Date.now(), notes: available && this.state.latest === latest ? this.state.notes : null });
      return this.state;
    } catch (err) {
      this.set({ phase: 'idle', available: false, error: `Couldn’t check for updates: ${err.message || err}.`, checkedAt: Date.now() });
      return this.state;
    }
  }

  /** Release notes for the latest version, as plain text. Best effort: the API is rate-limited. */
  async loadNotes() {
    if (!this.state.latest || this.state.notes) return this.state.notes;
    try {
      const r = await this.fetch(`https://api.github.com/repos/${this.repo}/releases/tags/v${this.state.latest}`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      this.set({ notes: plainNotes(data.body) || '' });
    } catch (_) {
      this.set({ notes: '' });
    }
    return this.state.notes;
  }

  releaseUrl() {
    return `https://github.com/${this.repo}/releases/${this.state.latest ? `tag/v${this.state.latest}` : 'latest'}`;
  }

  cancel() {
    if (this.controller) this.controller.abort();
  }

  /** Download, verify and install the latest version, then restart into it. */
  async install(quit) {
    const where = this.canInstall();
    if (!where.ok) { this.set({ error: where.message, errorReason: where.reason }); return { ok: false, error: where.message, reason: where.reason }; }
    if (!this.state.available || !this.state.latest) { await this.check(); if (!this.state.available) return { ok: false, error: 'Loupe is already up to date.' }; }

    const version = this.state.latest;
    const name = `Loupe-${version}-universal.dmg`;
    const url = `https://github.com/${this.repo}/releases/download/v${version}/${name}`;
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const dmg = path.join(this.cacheDir, name);
    const controller = new AbortController();
    this.controller = controller;
    let mount = null;
    try {
      // 1. Download
      this.set({ phase: 'downloading', error: null, errorReason: null, received: 0, total: 0 });
      const response = await this.fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) throw new Error(`the download failed (${response.status})`);
      const total = Number(response.headers.get('content-length')) || 0;
      const out = fs.createWriteStream(dmg);
      const reader = response.body.getReader();
      let received = 0; let last = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          received += chunk.length;
          if (Date.now() - last > 250) { last = Date.now(); this.set({ received, total }); }
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
      this.set({ received, total: total || received });

      // 2. Open the dmg and find the app in it
      this.set({ phase: 'verifying' });
      mount = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-update-'));
      await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg]);
      const newApp = path.join(mount, 'Loupe.app');
      if (!fs.existsSync(newApp)) throw new Error('the dmg doesn’t contain Loupe.app');

      // 3. Only accept an app signed with the same certificate as this one.
      const current = await run('/usr/bin/codesign', ['-d', '-r-', where.bundle]);
      const requirement = (/designated => (.+)/.exec(current.stdout + current.stderr) || [])[1];
      if (!requirement || /cdhash/.test(requirement)) throw new Error('this copy of Loupe isn’t signed with the Loupe certificate, so it can’t check the update. Install the new version by hand once.');
      try {
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${requirement}`, newApp]);
      } catch (err) {
        throw new Error('the downloaded app isn’t signed with the Loupe certificate, so it wasn’t installed');
      }
      const plist = await run('/usr/bin/defaults', ['read', path.join(newApp, 'Contents', 'Info.plist'), 'CFBundleShortVersionString']);
      const newVersion = plist.stdout.trim();
      if (compareVersions(newVersion, this.current) <= 0) throw new Error(`the downloaded app is version ${newVersion}, not newer than this one`);

      // 4. Copy it next to the current app (same disk, so the swap is a quick rename).
      this.set({ phase: 'installing' });
      const staged = path.join(path.dirname(where.bundle), '.Loupe-update.app');
      fs.rmSync(staged, { recursive: true, force: true });
      await run('/usr/bin/ditto', [newApp, staged]);
      await run('/usr/bin/hdiutil', ['detach', mount, '-quiet']).catch(() => {});
      mount = null;
      fs.rmSync(dmg, { force: true });

      // 5. After Loupe quits: swap the apps, put the old one back if that fails, start the new one.
      const script = path.join(this.cacheDir, 'swap.sh');
      fs.writeFileSync(script, swapScript({ pid: process.pid, app: where.bundle, staged }), { mode: 0o755 });
      const child = spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' });
      child.unref();
      this.set({ phase: 'restarting' });
      setTimeout(() => quit(), 300);
      return { ok: true, version: newVersion };
    } catch (err) {
      if (mount) await run('/usr/bin/hdiutil', ['detach', mount, '-quiet', '-force']).catch(() => {});
      const message = controller.signal.aborted ? 'Download cancelled.' : `Update failed: ${err.message || err}`;
      this.set({ phase: 'idle', error: message, errorReason: controller.signal.aborted ? 'cancelled' : 'error' });
      return { ok: false, error: message };
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}

function swapScript({ pid, app, staged }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/bash
# Written by Loupe to finish an update: waits for Loupe to quit, swaps in the new version, starts it.
APP=${q(app)}
NEW=${q(staged)}
OLD="$APP.previous"
for _ in $(seq 1 100); do kill -0 ${pid} 2>/dev/null || break; sleep 0.2; done
rm -rf "$OLD"
if mv "$APP" "$OLD" && mv "$NEW" "$APP"; then
  rm -rf "$OLD"
else
  [ -d "$APP" ] || mv "$OLD" "$APP"
  rm -rf "$NEW"
fi
open "$APP"
`;
}

module.exports = { Updater, compareVersions, plainNotes, swapScript };
