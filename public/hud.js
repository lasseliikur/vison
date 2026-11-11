// Mission Control: socket, voice in (wake word + push-to-talk), voice out, orb, panels.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

const S = {
  ws: null, cfg: {}, status: 'idle', agent: null,
  speaking: false, speakQueue: [], quietUntil: 0,
  armedUntil: 0, ptt: false, pttText: '', interim: '',
  approvals: [], level: 0, activated: false, patrolRunning: false,
};

// ---------------------------------------------------------------- socket
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => chip('chip-online', 'ONLINE', 'on');
  ws.onclose = () => { chip('chip-online', 'OFFLINE', 'bad'); setTimeout(connect, 1500); };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}
const send = (msg) => S.ws?.readyState === 1 && S.ws.send(JSON.stringify(msg));

function handle(m) {
  switch (m.type) {
    case 'hello':
      S.cfg = m.config;
      $('objective').textContent = m.config.objective.toUpperCase();
      $('session').textContent = m.session ? '#' + m.session.slice(0, 8).toUpperCase() : 'NEW';
      chip('chip-model', m.config.model.replace(/^claude-/, '').toUpperCase(), 'on');
      $('log').replaceChildren();
      m.log.forEach(addLog);
      setState(m.state);
      renderStats(m.stats);
      S.connectors = m.connectors; S.briefing = m.briefing; S.canvas = m.canvasStatus; S.google = m.google;
      renderConnectors(); renderActions(m.actions); renderPatrol();
      S.approvals = m.approvals; renderApproval();
      break;
    case 'state': setState(m.state); break;
    case 'telemetry': addLog(m.entry); break;
    case 'heard': caption('“' + m.text + '”'); break;
    case 'say': speak(m.text); break;
    case 'vitals': $('v-cpu').textContent = m.cpu + '%'; $('v-cpu-bar').style.width = m.cpu + '%'; break;
    case 'brain_stats': renderStats(m.stats); break;
    case 'connectors': S.connectors = m.connectors; renderConnectors(); break;
    case 'briefing': S.briefing = m.briefing; renderConnectors(); break;
    case 'actions': renderActions(m.actions); break;
    case 'canvas': S.canvas = m.status; renderConnectors(); break;
    case 'google': S.google = m.google; renderConnectors(); break;
    case 'patrol': S.patrolRunning = m.running; renderPatrol(); break;
    case 'approval': S.approvals.push(m.card); renderApproval(); break;
    case 'approval_done': S.approvals = S.approvals.filter((a) => a.id !== m.id); renderApproval(); break;
  }
}

// ---------------------------------------------------------------- panels
function chip(id, text, cls) { const c = $(id); c.textContent = text; c.className = 'chip ' + (cls || ''); }
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

function addLog(entry) {
  const li = el('li', 'l-' + entry.level);
  li.append(el('time', '', `[${hhmm(entry.at)}]`), entry.text);
  li.title = entry.text;
  const log = $('log');
  log.append(li);
  while (log.children.length > 200) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function renderStats(s) {
  $('v-latency').textContent = s.latencyMs == null ? '—' : (s.latencyMs / 1000).toFixed(1) + ' s to first word';
  $('v-tokens').textContent = s.tokens.toLocaleString();
  $('v-depth').textContent = `${s.turns} turns` + (s.contextTokens ? ` · ${Math.round(s.contextTokens / 1000)}k context` : '');
}

function renderPatrol() {
  if (S.patrolRunning) chip('chip-patrol', 'SCOUT SCANNING', 'warn');
  else if (S.cfg.patrolMinutes > 0) chip('chip-patrol', `PATROL ${S.cfg.patrolMinutes}M`, 'on');
  else chip('chip-patrol', 'PATROL OFF', '');
}

function renderConnectors() {
  const rows = [];
  const bad = (S.briefing?.unavailable || []).map((u) => u.toLowerCase());
  const down = (name) => bad.find((u) => u.startsWith(name.toLowerCase().split(/[\s_]/).pop()));
  for (const c of S.connectors || []) {
    if (c.name === 'vision') continue;
    const ok = c.status === 'connected';
    rows.push([c.name.replace(/^claude[._ ]ai[._ ]/i, '').replace(/_/g, ' '), ok ? 'OK' : c.status.toUpperCase(), ok ? 's-ok' : 's-warn']);
  }
  const cv = S.canvas || {};
  const days = cv.lastSync ? Math.floor((Date.now() - new Date(cv.lastSync)) / 864e5) : null;
  rows.push(['Canvas',
    !cv.configured ? 'NOT SET UP' : cv.running ? (cv.phase || 'syncing').toUpperCase().slice(0, 26)
      : days === null ? 'LOGIN NEEDED' : cv.due ? `SYNC DUE (${days}D OLD)` : days === 0 ? 'SYNCED TODAY' : `SYNCED ${days}D AGO`,
    !cv.configured || cv.due || days === null ? 's-warn' : 's-ok']);
  $('canvas-sync').classList.toggle('due', Boolean(cv.configured && (cv.due || days === null) && !cv.running));
  const g = S.google || { accounts: [] };
  for (const a of g.accounts) {
    const broken = bad.find((u) => u.includes(`(${a.label})`));
    rows.push([`Google · ${a.label} (${a.email || '…'})`, broken ? 'ERROR' : 'OK', broken ? 's-bad' : 's-ok']);
  }
  if (!g.accounts.length) rows.push(['Gmail + Calendar', g.configured ? 'ADD AN ACCOUNT' : 'NOT SET UP', 's-warn']);
  for (const src of g.accounts.length ? [] : ['gmail', 'calendar']) {
    if (rows.some((r) => r[0].toLowerCase().includes(src))) continue;
    const why = down(src);
    if (why) rows.push([src[0].toUpperCase() + src.slice(1), 'UNAVAILABLE', 's-bad']);
  }
  const list = $('connectors');
  list.replaceChildren(...rows.map(([name, status, cls]) => { const li = el('li'); li.append(el('span', '', name), el('span', cls, status)); return li; }));
  if (S.briefing) {
    const n = S.briefing.items.length, fresh = S.briefing.items.filter((i) => i.isNew).length;
    list.append(el('li', 'dim', `Last scan ${hhmm(S.briefing.at)} · ${n} items · ${fresh} new`));
  }
}

function renderActions(a) {
  const list = $('actions');
  if (!a || !a.actions.length) return;
  $('actions-at').textContent = 'ranked ' + hhmm(a.at);
  list.replaceChildren(...a.actions.map((x) => { const li = el('li'); li.append(el('strong', '', x.action), el('small', '', x.reason)); return li; }));
}

function renderApproval() {
  const card = S.approvals[0];
  $('approval').hidden = !card;
  if (!card) return;
  $('approval-title').textContent = `${card.agent.toUpperCase()}: ${card.title}`;
  // Show exactly what will happen: short fields first, the message body last.
  const input = card.input || {}, lines = [];
  for (const [k, v] of Object.entries(input)) if (k !== 'body' && k !== 'description') lines.push(`${k.replace(/_/g, ' ').toUpperCase()}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  for (const k of ['description', 'body']) if (input[k] != null) lines.push('', `${k.toUpperCase()}:`, String(input[k]));
  $('approval-input').textContent = lines.join('\n');
  $('deny').focus();
}
const answer = (allow) => { const c = S.approvals[0]; if (c) send({ type: 'approval', id: c.id, allow }); };
$('approve').onclick = () => answer(true);
$('deny').onclick = () => answer(false);
$('google-add').onclick = () => {
  const label = prompt('Name this Google account (for example: personal, or school)');
  // Same-tab navigation: a pop-up opened after a prompt is silently blocked by Chrome.
  if (label && label.trim()) location.href = '/oauth/google/start?label=' + encodeURIComponent(label.trim());
};
$('canvas-sync').onclick = () => send({ type: 'canvas_sync' });
$('patrol-now').onclick = () => send({ type: 'patrol_now' });
$('advise-now').onclick = () => send({ type: 'advise_now' });

function setState(state) { S.status = state.status; S.agent = state.agent; renderStatus(); }
function renderStatus() {
  const listening = S.ptt || Date.now() < S.armedUntil;
  $('status').textContent = listening ? 'LISTENING' : S.speaking ? 'SPEAKING'
    : S.status === 'working' ? `${(S.agent || 'agent').toUpperCase()} WORKING`
    : S.status === 'thinking' ? 'THINKING' : 'STANDBY';
}
const caption = (text) => { $('caption').textContent = text; };

setInterval(() => {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString();
  $('date').textContent = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
  renderStatus();
}, 500);

// ---------------------------------------------------------------- voice out
let audioCtx, outAnalyser, micAnalyser;
function beep(freq = 880) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.frequency.value = freq; g.gain.setValueAtTime(0.08, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
  o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.2);
}

function speak(text) { caption(text); S.speakQueue.push(text); if (!S.speaking) nextSpeech(); }

async function nextSpeech() {
  const text = S.speakQueue.shift();
  if (text == null) { S.speaking = false; S.quietUntil = Date.now() + 500; return; }
  S.speaking = true;
  caption(text);
  if (!S.activated) { setTimeout(nextSpeech, 1200); return; } // no audio before the first click
  try {
    if (S.cfg.elevenLabs) await speakEleven(text); else await speakBrowser(text);
  } catch { try { await speakBrowser(text); } catch { /* stay silent, caption shows it */ } }
  nextSpeech();
}

let currentAudio = null;
async function speakEleven(text) {
  const r = await fetch('/api/tts', { method: 'POST', body: JSON.stringify({ text }) });
  if (!r.ok) throw new Error('tts');
  const audio = new Audio(URL.createObjectURL(await r.blob()));
  currentAudio = audio;
  audioCtx.createMediaElementSource(audio).connect(outAnalyser);
  await new Promise((res, rej) => { audio.onended = res; audio.onerror = rej; audio.play().catch(rej); });
  URL.revokeObjectURL(audio.src); currentAudio = null;
}

function speakBrowser(text) {
  return new Promise((res, rej) => {
    if (!('speechSynthesis' in window)) return rej(new Error('no tts'));
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find((v) => /Google UK English Male|Daniel|Arthur/.test(v.name))
      || voices.find((v) => v.lang === 'en-GB') || voices.find((v) => v.lang?.startsWith('en')) || null;
    u.rate = 1.03;
    u.onboundary = () => { S.level = 0.9; }; // no analyser for this voice: pulse per word
    u.onend = res; u.onerror = res;
    speechSynthesis.speak(u);
  });
}

function stopSpeaking() {
  S.speakQueue.length = 0;
  speechSynthesis?.cancel();
  if (currentAudio) { currentAudio.pause(); currentAudio.onended?.(); }
}

// ---------------------------------------------------------------- voice in
const WAKE = /\b(?:hey|hay|hi|ok|okay|yo)[\s,]+(?:vision|visions|vizion|fission)\b[\s,.!?]*/i;
const YES = /^(approve|approved|yes|confirm|go ahead|do it|send it)\b/i;
const NO = /^(deny|denied|no|cancel|decline|don't|do not|stop)\b/i;

function command(text) {
  text = text.trim();
  if (!text) return;
  if (S.approvals.length && YES.test(text)) return answer(true);
  if (S.approvals.length && NO.test(text)) return answer(false);
  if (/^(stop|cancel|never mind|quiet)\.?$/i.test(text)) { stopSpeaking(); return send({ type: 'interrupt' }); }
  stopSpeaking();
  send({ type: 'command', text });
}

function startRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    chip('chip-mic', 'NO SPEECH API', 'warn');
    $('audio-note').textContent = 'This browser has no speech recognition. Use Chrome, or type below.';
    return;
  }
  const rec = new SR();
  rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
  rec.onstart = () => chip('chip-mic', 'MIC LIVE', 'on');
  rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { chip('chip-mic', 'MIC BLOCKED', 'bad'); rec.blocked = true; } };
  rec.onend = () => { if (!rec.blocked) setTimeout(() => { try { rec.start(); } catch { /* already running */ } }, 250); };
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript.trim();
      const final = e.results[i].isFinal;
      if (S.ptt) { if (final) { S.pttText += ' ' + text; S.interim = ''; } else S.interim = text; caption((S.pttText + ' ' + S.interim).trim()); continue; }
      if (S.speaking || Date.now() < S.quietUntil) continue; // do not hear ourselves
      if (!final) { if (Date.now() < S.armedUntil) caption(text); continue; }
      const wake = text.match(WAKE);
      if (wake) {
        const rest = text.slice(wake.index + wake[0].length).trim();
        if (rest) { S.armedUntil = 0; command(rest); } else { S.armedUntil = Date.now() + 8000; beep(); caption('Yes?'); }
      } else if (Date.now() < S.armedUntil) { S.armedUntil = 0; command(text); }
    }
  };
  try { rec.start(); } catch { /* ignore */ }
}

function pttDown() {
  if (S.ptt) return;
  activate();
  stopSpeaking();
  S.ptt = true; S.pttText = ''; S.interim = '';
  $('ptt').classList.add('held'); beep(660); caption('Listening…');
}
function pttUp() {
  if (!S.ptt) return;
  $('ptt').classList.remove('held');
  setTimeout(() => { // give the recogniser a moment to finalise the last words
    const text = (S.pttText + ' ' + S.interim).trim();
    S.ptt = false; S.pttText = ''; S.interim = '';
    if (text) command(text); else caption('I did not catch that.');
  }, 700);
}
const typing = () => document.activeElement?.tagName === 'INPUT';
addEventListener('keydown', (e) => { if (e.code === 'Space' && !typing() && !e.repeat) { e.preventDefault(); pttDown(); } });
addEventListener('keyup', (e) => { if (e.code === 'Space' && !typing()) { e.preventDefault(); pttUp(); } });
$('ptt').addEventListener('pointerdown', (e) => { e.preventDefault(); pttDown(); });
addEventListener('pointerup', () => S.ptt && pttUp());
$('ptt').addEventListener('keydown', (e) => e.preventDefault());
$('typed').addEventListener('submit', (e) => { e.preventDefault(); activate(); command($('typed-input').value); $('typed-input').value = ''; });

async function activate() {
  if (S.activated) return;
  S.activated = true;
  caption('Say “Hey Vision”, or hold the spacebar.');
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  outAnalyser = audioCtx.createAnalyser(); outAnalyser.fftSize = 256; outAnalyser.connect(audioCtx.destination);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micAnalyser = audioCtx.createAnalyser(); micAnalyser.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(micAnalyser);
    chip('chip-mic', 'MIC LIVE', 'on');
  } catch { chip('chip-mic', 'MIC BLOCKED', 'bad'); }
  startRecognition();
}
addEventListener('pointerdown', activate, { once: true });

// ---------------------------------------------------------------- waveform + orb
const wave = $('wave'), wctx = wave.getContext('2d');
const orb = $('orb'), octx = orb.getContext('2d');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const N = 1500, pts = [];
for (let i = 0; i < N; i++) { // Fibonacci sphere
  const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5));
  pts.push([Math.cos(a) * r, y, Math.sin(a) * r, Math.random()]);
}
function fit(c) {
  const d = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * d) || c.height !== Math.round(h * d)) { c.width = Math.round(w * d); c.height = Math.round(h * d); }
  return [c.width, c.height, d];
}
const rms = (an) => { const b = new Uint8Array(an.fftSize); an.getByteTimeDomainData(b); let s = 0; for (const v of b) s += ((v - 128) / 128) ** 2; return [Math.sqrt(s / b.length), b]; };
const COLORS = { idle: [47, 212, 255], listening: [59, 232, 160], thinking: [255, 197, 61], speaking: [150, 235, 255] };

let angle = 0;
function frame(t) {
  // input level
  let micLevel = 0, micData = null, outLevel = 0;
  if (micAnalyser) [micLevel, micData] = rms(micAnalyser);
  if (outAnalyser && currentAudio) [outLevel] = rms(outAnalyser);
  const listening = S.ptt || Date.now() < S.armedUntil;
  const target = S.speaking ? Math.max(outLevel * 4, S.level * 0.6) : listening ? micLevel * 5 : 0;
  S.level += (Math.min(1, target) - S.level) * 0.18;

  // waveform
  const [ww, wh] = fit(wave);
  wctx.clearRect(0, 0, ww, wh);
  wctx.strokeStyle = listening ? '#3be8a0' : '#2fd4ff'; wctx.lineWidth = Math.max(1, wh / 60); wctx.beginPath();
  for (let x = 0; x < ww; x += 3) {
    const v = micData ? (micData[Math.floor((x / ww) * micData.length)] - 128) / 128 : 0;
    const y = wh / 2 + Math.max(-0.48, Math.min(0.48, v * 1.2)) * wh;
    x ? wctx.lineTo(x, y) : wctx.moveTo(x, y);
  }
  wctx.stroke();

  // orb
  const [w, h, d] = fit(orb);
  const mode = listening ? 'listening' : S.speaking ? 'speaking' : S.status === 'idle' ? 'idle' : 'thinking';
  const [r, g, b] = COLORS[mode];
  const breathe = reduceMotion ? 0 : Math.sin(t / 1400) * 0.02;
  const R = Math.min(w, h) * 0.36 * (1 + breathe + S.level * 0.22);
  if (!reduceMotion) angle += mode === 'thinking' ? 0.012 : 0.0035;
  const ca = Math.cos(angle), sa = Math.sin(angle), tilt = 0.35, ct = Math.cos(tilt), st = Math.sin(tilt);
  octx.clearRect(0, 0, w, h);
  const glow = octx.createRadialGradient(w / 2, h / 2, R * 0.2, w / 2, h / 2, R * 1.5);
  glow.addColorStop(0, `rgba(${r},${g},${b},${0.10 + S.level * 0.18})`); glow.addColorStop(1, 'rgba(0,0,0,0)');
  octx.fillStyle = glow; octx.fillRect(0, 0, w, h);
  for (const [px, py, pz, seed] of pts) {
    const jitter = 1 + S.level * 0.12 * Math.sin(t / 90 + seed * 40);
    const x1 = (px * ca + pz * sa) * jitter, z1 = (-px * sa + pz * ca) * jitter;
    const y2 = py * jitter * ct - z1 * st, z2 = py * jitter * st + z1 * ct;
    const depth = (z2 + 1.2) / 2.2;
    octx.fillStyle = `rgba(${r},${g},${b},${0.15 + depth * 0.8})`;
    const size = (0.6 + depth * 1.5) * d;
    octx.fillRect(w / 2 + x1 * R - size / 2, h / 2 + y2 * R - size / 2, size, size);
  }
  octx.strokeStyle = `rgba(${r},${g},${b},0.55)`; octx.lineWidth = 1.5 * d;
  octx.beginPath(); octx.arc(w / 2, h / 2, R * 1.22, 0, Math.PI * 2); octx.stroke();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
connect();
