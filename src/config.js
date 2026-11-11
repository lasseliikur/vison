// Loads .env (no dependency) and exposes every setting Vision reads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.resolve(ROOT, process.env.VISION_DATA_DIR || 'data');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] in process.env) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
fs.mkdirSync(DATA, { recursive: true });

const env = process.env;
export const config = {
  port: Number(env.VISION_PORT || 8787),
  userName: env.USER_NAME || '',
  objective: env.VISION_OBJECTIVE || 'Stay ahead of email, calendar and coursework',
  model: env.VISION_MODEL || 'claude-sonnet-5-5',
  scoutModel: env.VISION_SCOUT_MODEL || env.VISION_MODEL || 'claude-sonnet-5-5',
  patrolModel: env.VISION_PATROL_MODEL || 'claude-haiku-5-5',
  patrolMinutes: Number(env.VISION_PATROL_MINUTES ?? 15),
  canvasUrl: (env.CANVAS_BASE_URL || '').replace(/\/+$/, ''),
  canvasToken: env.CANVAS_TOKEN || '',
  canvasSyncDays: Number(env.CANVAS_SYNC_DAYS || 7),
  browserPath: env.VISION_BROWSER_PATH || '',
  elevenKey: env.ELEVENLABS_API_KEY || '',
  elevenVoice: env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',
};

export function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); }
  catch { return fallback; }
}
export function writeJson(name, value) {
  fs.writeFileSync(path.join(DATA, name), JSON.stringify(value, null, 2));
}
export function appendLine(name, value) {
  fs.appendFileSync(path.join(DATA, name), JSON.stringify(value) + '\n');
}
export function tailLines(name, n) {
  try {
    return fs.readFileSync(path.join(DATA, name), 'utf8').trim().split('\n').slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Environment for every Claude Code child: agents run in the foreground so the answer is spoken in the same turn. */
export function childEnv() {
  const e = { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
  delete e.CLAUDE_AUTO_BACKGROUND_TASKS;
  return e;
}
