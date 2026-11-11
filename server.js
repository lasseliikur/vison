// Vision: local server for the Mission Control HUD. Run with `npm start`.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { ROOT, config, readJson } from './src/config.js';
import { SafetyGate } from './src/safety.js';
import { Brain } from './src/brain.js';
import { Patrol } from './src/patrol.js';
import { canvasReady } from './src/canvas.js';
import { CanvasSync } from './src/canvas-sync.js';
import { actions } from './src/tools.js';
import * as google from './src/google.js';

const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const ORIGINS = new Set([`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]);

// ---- HUD bus -------------------------------------------------------------
const clients = new Set();
const log = [];
let state = { status: 'idle', agent: null };
const hud = {
  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === 1) ws.send(data);
  },
  telemetry(text, level = 'info') {
    const entry = { at: Date.now(), text, level };
    log.push(entry);
    if (log.length > 200) log.shift();
    console.log(`[${new Date(entry.at).toLocaleTimeString()}] ${text}`);
    hud.broadcast({ type: 'telemetry', entry });
  },
  say(text) { hud.broadcast({ type: 'say', text }); },
  setState(status, agent = null) { state = { status, agent }; hud.broadcast({ type: 'state', state }); },
};

const gate = new SafetyGate(hud);
const brain = new Brain({ hud, gate });
hud.connectors = (list) => { brain.connectors = list; hud.broadcast({ type: 'connectors', connectors: list }); };
const patrol = new Patrol({ hud, gate });
const canvasSync = new CanvasSync({ hud, gate });
actions.syncCanvas = () => canvasSync.run();

// ---- HTTP ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Loopback only, and never for a page served from somewhere else.
  if (!ORIGINS.has(`http://${req.headers.host}`) || (req.headers.origin && !ORIGINS.has(req.headers.origin))) {
    res.writeHead(403).end('forbidden');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/tts') {
    if (!config.elevenKey) { res.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { text } = JSON.parse(body);
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${config.elevenVoice}`, {
        method: 'POST',
        headers: { 'xi-api-key': config.elevenKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: String(text).slice(0, 1200), model_id: 'eleven_turbo_v2_5' }),
      });
      if (!r.ok) throw new Error(`ElevenLabs HTTP ${r.status}`);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      hud.telemetry(`Voice failed, using the browser voice: ${e.message}`, 'warn');
      res.writeHead(502).end();
    }
    return;
  }

  if (req.method !== 'GET') { res.writeHead(405).end(); return; }

  // Connecting a Google account: start → Google's consent page → callback.
  const page = (title, text) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<body style="background:#040a13;color:#cfefff;font:16px ui-monospace,monospace;padding:48px"><h2 style="color:#2fd4ff"></h2><p></p><p><a style="color:#3be8a0" href="http://localhost:${config.port}/">← Back to Vision</a></p><script>document.querySelector('h2').textContent=${JSON.stringify(title)};document.querySelector('p').textContent=${JSON.stringify(text)}</script></body>`); };
  if (url.pathname === '/oauth/google/start') {
    try { res.writeHead(302, { Location: google.authUrl(url.searchParams.get('label')) }).end(); }
    catch (e) { page('Google is not ready', e.message); }
    return;
  }
  if (url.pathname === '/oauth/google/callback') {
    try {
      if (url.searchParams.get('error')) throw new Error(`Google said: ${url.searchParams.get('error')}`);
      const acct = await google.finishAuth(url.searchParams.get('code'), url.searchParams.get('state'));
      hud.telemetry(`Google connected — ${acct.label} (${acct.email})`, 'ok');
      hud.say(`Your ${acct.label} Google account is connected.`);
      hud.broadcast({ type: 'google', google: { configured: true, accounts: google.accounts() } });
      page('Connected', `${acct.label} (${acct.email}) is connected to Vision.`);
      patrol.run();
    } catch (e) {
      hud.telemetry(`Google sign-in failed: ${e.message}`, 'error');
      page('Google sign-in failed', e.message);
    }
    return;
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

// ---- WebSocket -----------------------------------------------------------
const wss = new WebSocketServer({
  server, path: '/ws',
  verifyClient: ({ origin, req }) => ORIGINS.has(origin) && ORIGINS.has(`http://${req.headers.host}`),
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: 'hello',
    config: {
      userName: config.userName, objective: config.objective, model: config.model,
      patrolMinutes: config.patrolMinutes, elevenLabs: Boolean(config.elevenKey), canvas: canvasReady(),
    },
    state, log, stats: brain.stats, connectors: brain.connectors,
    briefing: readJson('scout.json', null), actions: readJson('actions.json', null),
    approvals: gate.pendingCards(), session: brain.sessionId, canvasStatus: canvasSync.status(),
    google: { configured: google.googleConfigured(), accounts: google.accounts() },
  }));
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'command' && typeof msg.text === 'string' && msg.text.trim()) {
      const text = msg.text.trim().slice(0, 2000);
      hud.broadcast({ type: 'heard', text });
      if (/^(start fresh|new conversation|reset conversation)\.?$/i.test(text)) {
        brain.reset().then(() => hud.say('Starting fresh.'));
      } else brain.ask(text);
    } else if (msg.type === 'approval') gate.resolve(msg.id, msg.allow === true);
    else if (msg.type === 'interrupt') brain.interrupt();
    else if (msg.type === 'patrol_now') patrol.run();
    else if (msg.type === 'advise_now') patrol.advise();
    else if (msg.type === 'google_remove' && typeof msg.label === 'string') {
      google.removeAccount(msg.label);
      hud.telemetry(`Google account removed — ${msg.label}`, 'info');
      hud.broadcast({ type: 'google', google: { configured: google.googleConfigured(), accounts: google.accounts() } });
    }
    else if (msg.type === 'canvas_sync') canvasSync.run().then((note) => hud.telemetry(note, 'info'));
  });
});

// ---- Vitals --------------------------------------------------------------
let lastCpu = os.cpus();
setInterval(() => {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    for (const k of Object.keys(c.times)) total += c.times[k] - lastCpu[i].times[k];
    idle += c.times.idle - lastCpu[i].times.idle;
  });
  lastCpu = now;
  hud.broadcast({ type: 'vitals', cpu: total ? Math.round(100 * (1 - idle / total)) : 0 });
}, 2000);

server.listen(config.port, '127.0.0.1', () => {
  console.log(`\n  VISION online → http://localhost:${config.port}  (open in Chrome)\n`);
  hud.telemetry('Vision online', 'ok');
  if (!canvasReady()) hud.telemetry('Canvas not configured — add CANVAS_BASE_URL to .env', 'warn');
  patrol.start();
  // The weekly ask. Vision only asks; the login window opens when you say so.
  let askedOn = '';
  const weeklyAsk = () => {
    const today = new Date().toDateString();
    if (!canvasSync.status().due || canvasSync.running || askedOn === today || clients.size === 0) return;
    askedOn = today;
    hud.telemetry('Canvas sync is due — press SYNC CANVAS or say "sync Canvas"', 'warn');
    hud.say('Your weekly Canvas sync is due. Say sync Canvas when you are ready to sign in.');
    canvasSync.publish();
  };
  setInterval(weeklyAsk, 60 * 1000);
});
