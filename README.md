# VISION

A voice-first personal assistant with a Mission Control HUD. One brain routes work to three agents:

| Agent | Role | Can it change things? |
|---|---|---|
| **Scout** | Reads email, calendar, Canvas and the web. Says `UNAVAILABLE` instead of guessing. | Never |
| **Operator** | Sends, drafts, schedules, edits (email, calendar). | Only after your sign-off |
| **Advisor** | Reads the Scout's briefing and the Operator's log, returns the top 3 actions. | Never |

The brain is a Claude Code session driven through the Claude Agent SDK, on your own Claude login.

## Setup

You need Node 20+, Google Chrome, and Claude Code signed in (`npm install -g @anthropic-ai/claude-code`, then run `claude` once).

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm start
```

Open **http://localhost:8787** in Chrome, click once, allow the microphone.

## Talking to it

- Say **"Hey Vision, …"** — or say "Hey Vision", wait for the tone, then speak.
- **Hold the spacebar** (or the button) while you talk; release to send.
- Or type in the box under the orb.
- "Stop" interrupts. "Start fresh" clears the conversation.

## Connecting your accounts

- **Canvas** (read-only) — set `CANVAS_BASE_URL` in `.env`, then press **SYNC CANVAS** or say "sync Canvas".
  A Chrome window opens on the Canvas sign-in page; log in by hand and it closes itself. Vision then goes through
  every class (assignments, syllabus, modules, pages, course calendar, PDF and text files) and saves a digest of
  exams, deadlines and key info that it answers from all week. It asks you to sync again after 7 days.
  Vision never sees your password; it keeps only the session cookies, in `data/canvas-cookies.json`.
- **Gmail and Google Calendar** (any number of accounts) — see "Connecting Google" below.
- **Anything else later** — add an MCP server with `claude mcp add`, or paste its `mcpServers` block into
  `connections.json`. No code changes: the agents pick up new tools automatically.

The Active Connectors panel shows what actually loaded.

## Connecting Google

Vision talks to Gmail and Calendar through a Google "OAuth client" that you create once (free, about ten minutes).
Do this signed in to your **personal** Google account. Google renames these menus now and then; the items are the same.

1. Go to **console.cloud.google.com**, open the project menu at the top, **New project**, name it `Vision`, Create, and select it.
2. Menu → **APIs & Services → Library**. Search **Gmail API**, open it, **Enable**. Do the same for **Google Calendar API**.
3. Menu → **APIs & Services → OAuth consent screen** (also called Google Auth Platform) → **Get started**.
   App name `Vision`, your email as support email, audience **External**, your email as contact, finish.
4. In **Audience**, under **Test users**, add both of your Gmail addresses (personal and school).
5. In **Clients**, **Create client**, application type **Desktop app**, name `Vision`, Create.
   Copy the **Client ID** and **Client secret** into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
6. Restart Vision (`Ctrl+C`, then `npm start`). On the HUD press **ADD GOOGLE**, name the account `personal`,
   pick that account on Google's page and allow access. Press **ADD GOOGLE** again, name it `school`, and pick the school account.

Notes:
- Google shows a "Google hasn't verified this app" screen because the app is your own. Choose **Advanced → Go to Vision**.
- While the app is in **Testing**, Google signs each account out after 7 days and you press ADD GOOGLE again.
  To stop that, press **Publish app** on the Audience page (it stays private to you; the warning screen remains).
- A school may block apps it has not approved ("Access blocked: your institution's admin needs to review Vision").
  If that happens, auto-forward your school mail to your personal Gmail in Gmail's settings and Vision will see it there.
- Vision can read, send, draft, archive and label mail and read and edit calendars. It cannot permanently delete mail.
  Tokens live in `data/google-accounts.json`; remove access any time at myaccount.google.com → Security → Third-party access.

## What's new

Every `VISION_PATROL_MINUTES` the Scout checks unread email in every connected account, calendar events through tomorrow, and Canvas.
Anything it has not seen before is announced out loud and logged, then the Advisor re-ranks the top 3.

## Safety

- Read-only tool calls run freely. Every other call stops and shows a sign-off card; approve by button or by voice.
- `rules.json` holds the actions you have verified: `autoApprove` skips the card, `alwaysDeny` blocks outright.
  Example: add `"mcp__vision__gmail_create_draft"` to `autoApprove` to let drafts through without asking.
- The Scout and Advisor are refused any write even if you would have approved it.
- Every write attempt and its outcome is recorded in `data/operator-log.jsonl`.
- The server listens on 127.0.0.1 only and rejects other origins.

## Make it yours

- `persona.md` — how Vision speaks.
- `src/agents.js` — the three agents' instructions.
- `src/tools.js` — Vision's own tools (Canvas, memory, briefing).
- `public/` — the HUD.
- `data/` — conversation id, memory, briefing, logs. Delete it to reset everything.
