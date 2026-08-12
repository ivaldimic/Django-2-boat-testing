'use strict';

/*
 * Dev launcher
 * ------------
 * Starts the simulator (two boats) and the bridge (serves the web app over http),
 * waits until the app is reachable, then opens it in the browser. Ctrl+C stops
 * everything.
 *
 * Run:  node launcher.js       (or double-click start-dev.command / start-dev.bat)
 */

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}
const bridgeCfg = readJson(path.join(ROOT, 'bridge', 'config.json'), { port: 8080 });
const simCfg = readJson(path.join(ROOT, 'simulator', 'config.json'), { boats: [] });
const APP_PORT = bridgeCfg.port || 8080;
const APP_URL = `http://localhost:${APP_PORT}`;

function ensureDeps(dir) {
  if (fs.existsSync(path.join(dir, 'node_modules'))) return;
  console.log(`Installing dependencies in ${path.basename(dir)} (first run only)...`);
  const r = spawnSync(npmCmd, ['install'], { cwd: dir, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) { console.error(`npm install failed in ${dir}`); process.exit(1); }
}

const kids = [];
function launch(name, file, cwd) {
  const p = spawn(process.execPath, [file], { cwd });
  kids.push(p);
  prefix(name, p.stdout);
  prefix(name, p.stderr);
  p.on('exit', (code) => {
    if (code && code !== 0 && !shuttingDown) console.error(`  ${name} exited (code ${code})`);
  });
  return p;
}
function prefix(name, stream) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      process.stdout.write(`  ${name.padEnd(9)} | ${line}\n`);
    }
  });
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping...');
  for (const k of kids) { try { k.kill(); } catch (_) {} }
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function waitForApp(attempt = 0) {
  const req = http.get(APP_URL, (res) => {
    res.resume();
    onReady();
  });
  req.on('error', () => {
    if (attempt > 60) { console.error('App did not come up in time.'); return; }
    setTimeout(() => waitForApp(attempt + 1), 250);
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      const p = spawn('open', ['-a', 'Safari', url]);
      p.on('exit', (code) => { if (code !== 0) spawn('open', [url]); });
      p.on('error', () => spawn('open', [url]));
    } else if (isWin) {
      spawn('cmd', ['/c', 'start', '', url], { shell: true });
    } else {
      spawn('xdg-open', [url]).on('error', () => {});
    }
  } catch (_) {}
}

let opened = false;
function onReady() {
  if (opened) return;
  opened = true;
  const ports = (simCfg.boats || []).map((b) => b.port).join(' / ');
  console.log('');
  console.log('  ------------------------------------------------------------');
  console.log(`  Open the app:   ${APP_URL}`);
  console.log(`  Boats (sim):    ${ports ? 'ws://localhost:' + ports.replace(/ \/ /g, ' / ws://localhost:') : 'see simulator'}`);
  console.log('  Press Ctrl+C here to stop everything.');
  console.log('  ------------------------------------------------------------');
  console.log('');
  openBrowser(APP_URL);
}

// --- go ---
ensureDeps(path.join(ROOT, 'simulator'));
ensureDeps(path.join(ROOT, 'bridge'));
console.log('Starting simulator and bridge...\n');
launch('simulator', path.join(ROOT, 'simulator', 'simulator.js'), path.join(ROOT, 'simulator'));
launch('bridge', path.join(ROOT, 'bridge', 'bridge.js'), path.join(ROOT, 'bridge'));
waitForApp();
