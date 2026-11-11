// Vision's own tools, served to the brain and its agents as an in-process MCP server.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { DATA, readJson, tailLines } from './config.js';
import * as canvas from './canvas.js';
import * as google from './google.js';

/** Set by server.js: starts the weekly Canvas sync (and its login window). */
export const actions = { syncCanvas: null };

const MEMORY = path.join(DATA, 'memory.md');
export const readMemory = () => { try { return fs.readFileSync(MEMORY, 'utf8'); } catch { return ''; } };

const ok = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const wrap = (fn) => async (args) => {
  try { return ok(await fn(args)); }
  catch (e) { return { content: [{ type: 'text', text: `UNAVAILABLE: ${e.message}` }], isError: true }; }
};
const readOnly = { annotations: { readOnlyHint: true } };

export function visionServer() {
  return createSdkMcpServer({
    name: 'vision',
    version: '1.0.0',
    tools: [
      tool('canvas_get_digest', 'The saved weekly Canvas pull: every exam date, deadline and key fact found across all courses, plus all assignments with due dates. Works without a Canvas sign-in. Start here for any coursework question; check "synced_at" and say so if it is more than a week old.', {},
        wrap(() => {
          const digest = readJson('canvas-digest.json', null), snap = readJson('canvas-snapshot.json', null);
          if (!snap) return 'No Canvas sync has been done yet. Ask the user to say "sync Canvas" and sign in when the window opens.';
          return {
            synced_at: snap.at, digest,
            courses: snap.courses.map((c) => ({
              course_id: c.id, course: c.name, score: c.score,
              assignments: c.assignments.filter((a) => a.due).map((a) => ({ name: a.name, due: a.due, submitted: a.submitted, is_quiz: a.is_quiz })),
            })),
            course_events: snap.events, recent_announcements: snap.announcements.map((a) => ({ title: a.title, course: a.course, posted: a.posted })),
          };
        }), readOnly),
      tool('canvas_sync', 'Start the Canvas sync: opens a login window for the user if a sign-in is needed, then goes through every class and refreshes the saved digest. Takes a few minutes; the result is announced when it finishes, so do not wait for it.', {},
        wrap(() => (actions.syncCanvas ? actions.syncCanvas() : 'Canvas sync is not available.'))),
      tool('canvas_get_courses', 'List the user\'s active Canvas courses with current score and grade.', {},
        wrap(() => canvas.courses()), readOnly),
      tool('canvas_get_upcoming', 'Canvas assignments, quizzes and other planner items due in the next N days.',
        { days: z.number().int().min(1).max(60).default(7) },
        wrap(({ days }) => canvas.upcoming(days)), readOnly),
      tool('canvas_get_announcements', 'Course announcements posted in the last N days.',
        { days: z.number().int().min(1).max(30).default(7) },
        wrap(({ days }) => canvas.announcements(days)), readOnly),
      tool('canvas_get_assignments', 'Every assignment and quiz in one course with its due date, lock date and submission state. Use the course id from canvas_get_courses.',
        { course_id: z.number().int() }, wrap(({ course_id }) => canvas.assignments(course_id)), readOnly),
      tool('canvas_get_syllabus', 'The syllabus text of one course. Exam dates and times are usually here.',
        { course_id: z.number().int() }, wrap(({ course_id }) => canvas.syllabus(course_id)), readOnly),
      tool('canvas_get_calendar_events', 'Course calendar events (exams, review sessions, schedule changes) in the next N days, across all courses. Many instructors never put exams here, so an empty result does not mean there is no exam: check the syllabus and pages too.',
        { days: z.number().int().min(1).max(180).default(30) }, wrap(({ days }) => canvas.calendarEvents(days)), readOnly),
      tool('canvas_get_modules', 'The modules of one course and the items inside them (pages, assignments, files), with due dates where Canvas has them.',
        { course_id: z.number().int() }, wrap(({ course_id }) => canvas.modules(course_id)), readOnly),
      tool('canvas_list_pages', 'List the wiki pages of one course (schedule pages, exam info, week overviews).',
        { course_id: z.number().int() }, wrap(({ course_id }) => canvas.pages(course_id)), readOnly),
      tool('canvas_get_page', 'Read one course page. Use page_url from canvas_list_pages or canvas_get_modules.',
        { course_id: z.number().int(), page_url: z.string() }, wrap(({ course_id, page_url }) => canvas.page(course_id, page_url)), readOnly),
      tool('canvas_list_files', 'List the files uploaded to one course (syllabus PDFs, schedules, exam info sheets), newest first.',
        { course_id: z.number().int() }, wrap(({ course_id }) => canvas.files(course_id)), readOnly),
      tool('canvas_read_file', 'Read the text of one Canvas file: PDFs and plain text or HTML files. Use file_id from canvas_list_files, or content_id of a File item from canvas_get_modules. Long PDFs come back in parts: call again with next_start_page.',
        { file_id: z.number().int(), start_page: z.number().int().min(1).default(1) },
        wrap(({ file_id, start_page }) => canvas.fileText(file_id, start_page)), readOnly),
      // ---- Google: Gmail and Calendar, per connected account ----
      tool('google_list_accounts', 'The Google accounts connected to Vision, by label and email address.', {},
        wrap(() => google.accounts()), readOnly),
      tool('gmail_search', 'Search one Gmail account with Gmail search syntax (e.g. "is:unread in:inbox", "from:name newer_than:7d"). Returns sender, subject, date and a snippet per message.',
        { account: z.string().describe('Which connected Google account: its label (e.g. "personal", "school") or its email address.'), query: z.string().default('in:inbox'), max: z.number().int().min(1).max(25).default(10) },
        wrap(({ account, query, max }) => google.gmailSearch(account, query, max)), readOnly),
      tool('gmail_read', 'Read the full text of one email. Use message_id from gmail_search.',
        { account: z.string().describe('Which connected Google account: its label (e.g. "personal", "school") or its email address.'), message_id: z.string() }, wrap(({ account, message_id }) => google.gmailRead(account, message_id)), readOnly),
      tool('gmail_send', 'Send an email from one account. The user is shown the exact message and must confirm before it goes. To reply inside an existing thread also pass reply_to_message_id.',
        { account: z.string().describe('Which connected Google account: its label (e.g. "personal", "school") or its email address.'), to: z.string().describe('Recipient address(es). Always give it explicitly, even on a reply, so the user sees who gets it.'), subject: z.string().describe('Always give it explicitly; on a reply use "Re: <original subject>".'), body: z.string(), cc: z.string().optional(), bcc: z.string().optional(), reply_to_message_id: z.string().optional() },
        wrap(({ account, ...mail }) => google.gmailSend(account, mail))),
      tool('gmail_create_draft', 'Save an email as a draft in one account without sending it. Same fields as gmail_send.',
        { account: z.string().describe('Which connected Google account: its label (e.g. "personal", "school") or its email address.'), to: z.string().describe('Recipient address(es). Always give it explicitly, even on a reply, so the user sees who gets it.'), subject: z.string().describe('Always give it explicitly; on a reply use "Re: <original subject>".'), body: z.string(), cc: z.string().optional(), bcc: z.string().optional(), reply_to_message_id: z.string().optional() },
        wrap(({ account, ...mail }) => google.gmailDraft(account, mail))),
      tool('gmail_modify', 'Change one email: mark_read, mark_unread, archive, star, unstar or trash.',
        { account: z.string().describe('Which connected Google account: its label (e.g. "personal", "school") or its email address.'), message_id: z.string(), action: z.enum(['mark_read', 'mark_unread', 'archive', 'star', 'unstar', 'trash']) },
        wrap(({ account, message_id, action }) => google.gmailModify(account, message_id, action))),
      tool('calendar_list_events', 'List events on one account\'s Google Calendar between two times (ISO 8601). Defaults to the next 7 days.',
        { account: z.string().describe('Which connected Google account: its label (e.g. "personal", "school") or its email address.'), from: z.string().optional(), to: z.string().optional(), query: z.string().optional(), max: z.number().int().min(1).max(100).default(25) },
        wrap(({ account, ...q }) => google.calendarList(account, q)), readOnly),
      tool('calendar_create_event', `Create a calendar event. The user must confirm first. start/end are ISO 8601 local times in ${google.TIMEZONE} (e.g. 2026-11-12T15:00:00), or YYYY-MM-DD for an all-day event. End defaults to one hour after start.`,
        { account: z.string().describe('Which connected Google account: its label (e.g. "personal", "school") or its email address.'), title: z.string(), start: z.string(), end: z.string().optional(), location: z.string().optional(), description: z.string().optional(), attendees: z.array(z.string()).optional() },
        wrap(({ account, ...ev }) => google.calendarCreate(account, ev))),
      tool('calendar_update_event', 'Change an existing calendar event (move it, rename it, change place or guests). Only the fields you pass change. Use event_id from calendar_list_events. The user must confirm first.',
        { account: z.string().describe('Which connected Google account: its label (e.g. "personal", "school") or its email address.'), event_id: z.string(), title: z.string().optional(), start: z.string().optional(), end: z.string().optional(), location: z.string().optional(), description: z.string().optional(), attendees: z.array(z.string()).optional() },
        wrap(({ account, event_id, ...changes }) => google.calendarUpdate(account, event_id, changes))),
      tool('calendar_delete_event', 'Delete a calendar event. The user must confirm first.',
        { account: z.string().describe('Which connected Google account: its label (e.g. "personal", "school") or its email address.'), event_id: z.string() }, wrap(({ account, event_id }) => google.calendarDelete(account, event_id))),
      tool('get_briefing', 'The Scout\'s latest patrol snapshot (new email, calendar, Canvas) and the Advisor\'s current top actions.', {},
        wrap(() => ({ scout: readJson('scout.json', null), actions: readJson('actions.json', null) })), readOnly),
      tool('get_operator_log', 'The most recent actions the Operator took or was refused, newest last.',
        { limit: z.number().int().min(1).max(100).default(20) },
        wrap(({ limit }) => tailLines('operator-log.jsonl', limit)), readOnly),
      tool('memory_remember', 'Save one durable fact or preference the user told you, in a single line.',
        { fact: z.string().min(3).max(400) },
        wrap(({ fact }) => {
          fs.appendFileSync(MEMORY, `- ${fact.replace(/\s+/g, ' ').trim()}\n`);
          return 'Saved.';
        })),
    ],
  });
}
