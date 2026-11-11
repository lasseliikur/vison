// Canvas LMS reader. Sign-in is a browser window the user logs into by hand
// (src/canvas-login.js); the session cookies from that window are what every
// request here uses. A CANVAS_TOKEN in .env is an optional alternative.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, config } from './config.js';

export const canvasReady = () => Boolean(config.canvasUrl);
export const LOGIN_NEEDED = 'Canvas login is needed. The saved weekly digest may still have the answer (canvas_get_digest); '
  + 'otherwise tell the user to say "sync Canvas" and sign in when the window opens.';

const JAR = path.join(DATA, 'canvas-cookies.json');
let jar = null; // { name: value } for the Canvas host
function loadJar() {
  if (jar === null) { try { jar = JSON.parse(fs.readFileSync(JAR, 'utf8')); } catch { jar = {}; } }
  return jar;
}
export function saveCookies(cookies) {
  jar = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
  fs.writeFileSync(JAR, JSON.stringify(jar), { mode: 0o600 });
}
function authHeaders() {
  if (config.canvasToken) return { Authorization: `Bearer ${config.canvasToken}` };
  const pairs = Object.entries(loadJar());
  if (!pairs.length) throw new Error(LOGIN_NEEDED);
  return { Cookie: pairs.map(([k, v]) => `${k}=${v}`).join('; ') };
}
function absorb(res) { // Canvas re-issues its session cookie as it goes
  let changed = false;
  for (const line of res.headers.getSetCookie?.() || []) {
    const m = line.match(/^([^=;\s]+)=([^;]*)/);
    if (m && loadJar()[m[1]] !== m[2]) { jar[m[1]] = m[2]; changed = true; }
  }
  if (changed && !config.canvasToken) fs.writeFileSync(JAR, JSON.stringify(jar), { mode: 0o600 });
}

async function api(pathname, { params } = {}) {
  if (!canvasReady()) throw new Error('Canvas is not configured (set CANVAS_BASE_URL in .env).');
  const url = new URL(config.canvasUrl + '/api/v1' + pathname);
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { ...authHeaders(), Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(20000),
  });
  absorb(res);
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) throw new Error(LOGIN_NEEDED);
  if (!res.ok) throw new Error(`Canvas ${pathname} failed: HTTP ${res.status}`);
  // Cookie-authenticated responses are prefixed with "while(1);".
  return JSON.parse((await res.text()).replace(/^while\(1\);/, ''));
}

/** True when Canvas accepts the saved sign-in right now. */
export async function signedIn() {
  try { await api('/users/self'); return true; } catch { return false; }
}

const strip = (html) => (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export async function courses() {
  const list = await api('/courses', { params: { enrollment_state: 'active', per_page: 50, 'include[]': ['total_scores'] } });
  return list.filter((c) => c.name).map((c) => ({
    id: c.id, name: c.name, code: c.course_code,
    score: c.enrollments?.[0]?.computed_current_score ?? null,
    grade: c.enrollments?.[0]?.computed_current_grade ?? null,
  }));
}

/** Planner items (assignments, quizzes, discussions…) due in the next `days` days. */
export async function upcoming(days = 7) {
  const start = new Date();
  const end = new Date(Date.now() + days * 864e5);
  const items = await api('/planner/items', {
    params: { start_date: start.toISOString(), end_date: end.toISOString(), per_page: 50 },
  });
  return items.map((i) => ({
    id: `${i.plannable_type}:${i.plannable_id}`,
    plannable_type: i.plannable_type, plannable_id: i.plannable_id,
    title: i.plannable?.title || i.plannable?.name || '(untitled)',
    course: i.context_name || '',
    due: i.plannable?.due_at || i.plannable_date || null,
    submitted: Boolean(i.submissions?.submitted),
    done: Boolean(i.planner_override?.marked_complete),
    url: i.html_url ? config.canvasUrl + i.html_url : null,
  }));
}

export async function announcements(days = 7) {
  const list = await courses();
  if (!list.length) return [];
  const items = await api('/announcements', {
    params: {
      'context_codes[]': list.map((c) => `course_${c.id}`),
      start_date: new Date(Date.now() - days * 864e5).toISOString(), per_page: 30,
    },
  });
  const names = Object.fromEntries(list.map((c) => [`course_${c.id}`, c.name]));
  return items.map((a) => ({
    id: `announcement:${a.id}`, title: a.title, course: names[a.context_code] || '',
    posted: a.posted_at, body: strip(a.message).slice(0, 600),
  }));
}

export async function assignments(courseId) {
  const list = await api(`/courses/${courseId}/assignments`, { params: { per_page: 100, order_by: 'due_at', 'include[]': ['submission'] } });
  return list.map((a) => ({
    id: a.id, name: a.name, due: a.due_at, unlock: a.unlock_at, lock: a.lock_at, points: a.points_possible,
    is_quiz: Boolean(a.is_quiz_assignment || a.quiz_id),
    submitted: Boolean(a.submission?.submitted_at), score: a.submission?.score ?? null,
    description: strip(a.description).slice(0, 500), url: a.html_url,
  }));
}

/** The syllabus page: where exam dates usually live. */
export async function syllabus(courseId) {
  const c = await api(`/courses/${courseId}`, { params: { 'include[]': ['syllabus_body'] } });
  return { course: c.name, syllabus: strip(c.syllabus_body).slice(0, 20000) || '(This course has no syllabus text on Canvas.)' };
}

export async function pages(courseId) {
  const list = await api(`/courses/${courseId}/pages`, { params: { per_page: 100, sort: 'updated_at', order: 'desc' } });
  return list.map((p) => ({ page_url: p.url, title: p.title, updated: p.updated_at, front_page: Boolean(p.front_page) }));
}

export async function page(courseId, pageUrl) {
  const p = await api(`/courses/${courseId}/pages/${encodeURIComponent(pageUrl)}`);
  return { title: p.title, updated: p.updated_at, body: strip(p.body).slice(0, 20000) };
}

export async function modules(courseId) {
  const list = await api(`/courses/${courseId}/modules`, { params: { per_page: 50, 'include[]': ['items', 'content_details'] } });
  return list.map((m) => ({
    name: m.name,
    items: (m.items || []).map((i) => ({
      title: i.title, type: i.type, page_url: i.page_url || null, content_id: i.content_id || null,
      due: i.content_details?.due_at || null,
    })),
  }));
}

/** Course calendar events (exams, review sessions, moved lectures) in the next `days` days. */
export async function calendarEvents(days = 30, list = null) {
  list = list || await courses();
  if (!list.length) return [];
  const names = Object.fromEntries(list.map((c) => [`course_${c.id}`, c.name]));
  const events = await api('/calendar_events', {
    params: {
      type: 'event', per_page: 100, 'context_codes[]': list.slice(0, 10).map((c) => `course_${c.id}`),
      start_date: new Date().toISOString(), end_date: new Date(Date.now() + days * 864e5).toISOString(),
    },
  });
  return events.map((e) => ({
    id: `event:${e.id}`, title: e.title, course: names[e.context_code] || '', start: e.start_at, end: e.end_at,
    location: e.location_name || '', description: strip(e.description).slice(0, 400),
  }));
}

export async function files(courseId) {
  const list = await api(`/courses/${courseId}/files`, { params: { per_page: 100, sort: 'updated_at', order: 'desc' } });
  return list.map((f) => ({ file_id: f.id, name: f.display_name, type: f['content-type'], size_kb: Math.round(f.size / 1024), updated: f.updated_at }));
}

const MAX_FILE_BYTES = 30 * 1024 * 1024;

/** Download one Canvas file and return its text. Reads PDFs and plain text or HTML files. */
export async function fileText(fileId, startPage = 1, maxChars = 30000) {
  const meta = await api(`/files/${fileId}`);
  const name = meta.display_name || meta.filename || String(fileId);
  const type = meta['content-type'] || '';
  if (meta.size > MAX_FILE_BYTES) throw new Error(`${name} is too large to read (${Math.round(meta.size / 1048576)} MB).`);
  const isPdf = /pdf/i.test(type) || /\.pdf$/i.test(name);
  const isText = /^text\/|json|xml/i.test(type) || /\.(txt|md|csv|html?)$/i.test(name);
  if (!isPdf && !isText) throw new Error(`${name} is a ${type || 'file type'} Vision cannot read. Only PDF and text files are supported.`);

  // The download link is pre-signed and lives on another host, so no token is sent with it.
  const sameHost = new URL(meta.url).host === new URL(config.canvasUrl).host;
  const res = await fetch(meta.url, { headers: sameHost ? authHeaders() : {}, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Downloading ${name} failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  if (isText) {
    const text = strip(new TextDecoder().decode(bytes));
    return { name, text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text: pagesText } = await extractText(pdf, { mergePages: false });
  let text = '', page = Math.max(1, startPage), lastPage = page - 1;
  for (; page <= totalPages; page++) {
    const chunk = `\n[page ${page}]\n${(pagesText[page - 1] || '').replace(/[ \t]+/g, ' ').trim()}`;
    if (text.length + chunk.length > maxChars && text) break;
    text += chunk; lastPage = page;
  }
  const empty = !text.replace(/\[page \d+\]/g, '').trim();
  return {
    name, total_pages: totalPages, pages_returned: `${Math.max(1, startPage)}-${lastPage}`,
    next_start_page: lastPage < totalPages ? lastPage + 1 : null,
    text: empty ? '(No text could be extracted: this PDF is probably a scan of images.)' : text.slice(0, maxChars + 2000),
  };
}
