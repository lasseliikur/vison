// Gmail and Google Calendar, for as many Google accounts as the user connects
// (e.g. "personal" and "school"). Sign-in is Google's own consent page in the
// user's browser; Vision keeps only the resulting tokens, in data/google-accounts.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, config } from './config.js';

const env = process.env;
const AUTH_URL = env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const GMAIL = env.GOOGLE_GMAIL_BASE || 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = env.GOOGLE_CALENDAR_BASE || 'https://www.googleapis.com/calendar/v3';
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar'];
const STORE = path.join(DATA, 'google-accounts.json');
const REDIRECT = () => `http://127.0.0.1:${config.port}/oauth/google/callback`;
export const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const googleConfigured = () => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

// ---------------------------------------------------------------- accounts
function load() { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; } }
function save(all) { fs.writeFileSync(STORE, JSON.stringify(all, null, 2), { mode: 0o600 }); }
export const accounts = () => Object.entries(load()).map(([label, a]) => ({ label, email: a.email }));
export function removeAccount(label) { const all = load(); delete all[label]; save(all); }

const pending = new Map(); // state → label
export function authUrl(label) {
  if (!googleConfigured()) throw new Error('Google is not set up: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env (see README).');
  label = String(label || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  if (!label) throw new Error('Give the account a short name, like "personal" or "school".');
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, label);
  setTimeout(() => pending.delete(state), 15 * 60 * 1000);
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: REDIRECT(), response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account', state,
  });
  return u.toString();
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.error || `Google token request failed: HTTP ${res.status}`);
  return body;
}

/** Finishes the consent redirect. Returns the connected {label, email}. */
export async function finishAuth(code, state) {
  const label = pending.get(state);
  if (!label) throw new Error('This sign-in link has expired. Start again from Vision.');
  pending.delete(state);
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT() });
  if (!t.refresh_token) throw new Error('Google did not return a long-lived token. Remove Vision under myaccount.google.com → Security → Third-party access, then connect again.');
  const all = load();
  all[label] = { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in - 60) * 1000 };
  save(all);
  const profile = await api(label, `${GMAIL}/profile`);
  const again = load();
  again[label].email = profile.emailAddress;
  save(again);
  return { label, email: profile.emailAddress };
}

function resolve(label) {
  const all = load();
  const labels = Object.keys(all);
  if (!labels.length) throw new Error('No Google account is connected. The user connects one with the ADD GOOGLE button on the HUD.');
  const key = labels.find((l) => l === String(label || '').toLowerCase()) || labels.find((l) => all[l].email === label);
  if (!key) throw new Error(`No Google account called "${label}". Connected: ${labels.map((l) => `${l} (${all[l].email})`).join(', ')}.`);
  return key;
}

async function accessToken(label) {
  const all = load();
  const a = all[label];
  if (a.access_token && Date.now() < a.expires_at) return a.access_token;
  let t;
  try { t = await tokenRequest({ refresh_token: a.refresh_token, grant_type: 'refresh_token' }); }
  catch (e) { throw new Error(`The "${label}" Google sign-in has expired or was revoked (${e.message}). The user needs to connect it again with ADD GOOGLE.`); }
  a.access_token = t.access_token;
  a.expires_at = Date.now() + (t.expires_in - 60) * 1000;
  save(all);
  return a.access_token;
}

async function api(label, url, { method = 'GET', params, body } = {}) {
  const key = resolve(label);
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
    else if (v != null && v !== '') u.searchParams.set(k, v);
  }
  const res = await fetch(u, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(key)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000),
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google (${key}) ${method} failed: ${data.error?.message || 'HTTP ' + res.status}`);
  return data;
}

// ---------------------------------------------------------------- gmail
const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const strip = (html) => html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

function bodyText(payload) {
  const parts = [];
  (function walk(p) { if (!p) return; if (p.parts) p.parts.forEach(walk); else parts.push(p); })(payload);
  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data);
  if (plain) return unb64(plain.body.data);
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data);
  return html ? strip(unb64(html.body.data)) : '';
}

export async function gmailSearch(label, query = 'in:inbox', max = 10) {
  const list = await api(label, `${GMAIL}/messages`, { params: { q: query, maxResults: Math.min(max, 25) } });
  const out = [];
  for (const m of list.messages || []) {
    const msg = await api(label, `${GMAIL}/messages/${m.id}`, { params: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] } });
    out.push({
      account: resolve(label), message_id: msg.id, thread_id: msg.threadId, from: header(msg, 'From'), to: header(msg, 'To'),
      subject: header(msg, 'Subject'), date: header(msg, 'Date'), snippet: msg.snippet,
      unread: (msg.labelIds || []).includes('UNREAD'),
    });
  }
  return out;
}

export async function gmailRead(label, messageId) {
  const msg = await api(label, `${GMAIL}/messages/${encodeURIComponent(messageId)}`, { params: { format: 'full' } });
  const attachments = [];
  (function walk(p) { if (!p) return; if (p.filename) attachments.push(p.filename); (p.parts || []).forEach(walk); })(msg.payload);
  return {
    account: resolve(label), message_id: msg.id, thread_id: msg.threadId, from: header(msg, 'From'), to: header(msg, 'To'),
    cc: header(msg, 'Cc'), subject: header(msg, 'Subject'), date: header(msg, 'Date'),
    body: bodyText(msg.payload).slice(0, 20000), attachments,
  };
}

const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim(); // no header injection
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

async function buildRaw(label, { to, cc, bcc, subject, body, reply_to_message_id }) {
  const lines = [];
  let threadId;
  if (reply_to_message_id) {
    const orig = await api(label, `${GMAIL}/messages/${encodeURIComponent(reply_to_message_id)}`,
      { params: { format: 'metadata', metadataHeaders: ['Message-ID', 'References', 'Subject', 'From', 'Reply-To'] } });
    threadId = orig.threadId;
    const mid = header(orig, 'Message-ID');
    if (mid) lines.push(`In-Reply-To: ${mid}`, `References: ${clean(`${header(orig, 'References')} ${mid}`)}`);
    if (!subject) subject = /^re:/i.test(header(orig, 'Subject')) ? header(orig, 'Subject') : `Re: ${header(orig, 'Subject')}`;
    if (!to) to = header(orig, 'Reply-To') || header(orig, 'From');
  }
  if (!clean(to)) throw new Error('An email needs a recipient.');
  lines.unshift(`To: ${clean(to)}`, ...(cc ? [`Cc: ${clean(cc)}`] : []), ...(bcc ? [`Bcc: ${clean(bcc)}`] : []),
    `Subject: ${encodeWord(clean(subject))}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
  const raw = `${lines.join('\r\n')}\r\n\r\n${Buffer.from(String(body || '')).toString('base64').replace(/(.{76})/g, '$1\r\n')}`;
  return { raw: b64url(raw), ...(threadId ? { threadId } : {}) };
}

export async function gmailSend(label, mail) {
  const sent = await api(label, `${GMAIL}/messages/send`, { method: 'POST', body: await buildRaw(label, mail) });
  return { sent: true, account: resolve(label), message_id: sent.id };
}
export async function gmailDraft(label, mail) {
  const d = await api(label, `${GMAIL}/drafts`, { method: 'POST', body: { message: await buildRaw(label, mail) } });
  return { drafted: true, account: resolve(label), draft_id: d.id };
}

const MODS = {
  mark_read: { removeLabelIds: ['UNREAD'] }, mark_unread: { addLabelIds: ['UNREAD'] },
  archive: { removeLabelIds: ['INBOX'] }, star: { addLabelIds: ['STARRED'] }, unstar: { removeLabelIds: ['STARRED'] },
};
export async function gmailModify(label, messageId, action) {
  const id = encodeURIComponent(messageId);
  if (action === 'trash') await api(label, `${GMAIL}/messages/${id}/trash`, { method: 'POST' });
  else if (MODS[action]) await api(label, `${GMAIL}/messages/${id}/modify`, { method: 'POST', body: MODS[action] });
  else throw new Error(`Unknown action "${action}".`);
  return { done: action, account: resolve(label) };
}

// ---------------------------------------------------------------- calendar
const shape = (e, account) => ({
  account, event_id: e.id, title: e.summary || '(no title)', start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
  all_day: Boolean(e.start?.date), location: e.location || '', description: (e.description || '').slice(0, 500),
  attendees: (e.attendees || []).map((a) => a.email), link: e.htmlLink,
});
const when = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : { dateTime: v, timeZone: TIMEZONE });
const calPath = (calendarId) => `${CAL}/calendars/${encodeURIComponent(calendarId || 'primary')}/events`;

export async function calendarList(label, { from, to, query, max = 25, calendar_id } = {}) {
  const r = await api(label, calPath(calendar_id), {
    params: {
      timeMin: new Date(from || Date.now()).toISOString(), timeMax: new Date(to || Date.now() + 7 * 864e5).toISOString(),
      q: query, singleEvents: 'true', orderBy: 'startTime', maxResults: Math.min(max, 100),
    },
  });
  return (r.items || []).map((e) => shape(e, resolve(label)));
}

function eventBody({ title, start, end, location, description, attendees }) {
  const b = {};
  if (title != null) b.summary = title;
  if (start) b.start = when(start);
  if (end) b.end = when(end);
  if (location != null) b.location = location;
  if (description != null) b.description = description;
  if (attendees) b.attendees = attendees.map((email) => ({ email }));
  return b;
}
export async function calendarCreate(label, ev) {
  if (!ev.title || !ev.start) throw new Error('An event needs a title and a start.');
  if (!ev.end) ev.end = /^\d{4}-\d{2}-\d{2}$/.test(ev.start) ? ev.start : new Date(new Date(ev.start).getTime() + 3600e3).toISOString();
  return shape(await api(label, calPath(ev.calendar_id), { method: 'POST', body: eventBody(ev) }), resolve(label));
}
export async function calendarUpdate(label, eventId, changes) {
  return shape(await api(label, `${calPath(changes.calendar_id)}/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: eventBody(changes) }), resolve(label));
}
export async function calendarDelete(label, eventId, calendarId) {
  await api(label, `${calPath(calendarId)}/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  return { deleted: true, account: resolve(label) };
}
