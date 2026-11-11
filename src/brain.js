// The core runtime: one resumable Claude Code session that holds the conversation
// and routes work to the Scout, the Operator and the Advisor.
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ROOT, DATA, config, readJson, writeJson, childEnv } from './config.js';
import { visionServer } from './tools.js';
import { agents, brainPrompt } from './agents.js';

/** Extra MCP servers the user wired in by hand (same shape as Claude Code's mcpServers block). */
export function userConnections() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'connections.json'), 'utf8')).mcpServers || {}; }
  catch { return {}; }
}

const BUILTINS = ['Agent', 'WebSearch', 'WebFetch'];
const nice = (tool) => tool.replace(/^mcp__(.+?)__/, '').replace(/_/g, ' ');

/** Splits a token stream into speakable sentences. */
class Sentences {
  constructor(emit) { this.emit = emit; this.buf = ''; }
  push(text) {
    this.buf += text;
    let m;
    while ((m = this.buf.match(/^([\s\S]{12,}?[.!?]["')\]]?)\s+/))) {
      this.emit(m[1].trim());
      this.buf = this.buf.slice(m[0].length);
    }
  }
  flush() { if (this.buf.trim()) this.emit(this.buf.trim()); this.buf = ''; }
}

export class Brain {
  constructor({ hud, gate }) {
    this.hud = hud;
    this.gate = gate;
    this.sessionId = readJson('session.json', {}).sessionId || null;
    this.queue = Promise.resolve();
    this.current = null;
    this.stats = { turns: 0, tokens: 0, latencyMs: null, contextTokens: 0 };
    this.connectors = [];
  }

  /** Queue one spoken or typed command. */
  ask(text) {
    this.queue = this.queue.then(() => this.turn(text)).catch((e) => {
      this.hud.telemetry(`Brain error: ${e.message}`, 'error');
      this.hud.say('Something went wrong on my side. The details are in the telemetry log.');
      this.hud.setState('idle');
    });
    return this.queue;
  }

  async interrupt() { try { await this.current?.interrupt(); } catch { /* already finished */ } }

  options() {
    return {
      model: config.model,
      systemPrompt: brainPrompt(),
      cwd: DATA,
      env: childEnv(),
      // 'user' brings in the MCP servers and claude.ai connectors the user's own Claude Code has.
      settingSources: ['user'],
      mcpServers: { ...userConnections(), vision: visionServer() },
      agents,
      tools: BUILTINS,
      permissionMode: 'default',
      canUseTool: this.gate.handler(),
      includePartialMessages: true,
      hooks: {
        ...this.gate.hook(),
        SubagentStart: [{ hooks: [async (input) => { this.gate.noteAgent(input.agent_id, input.agent_type); return {}; }] }],
      },
      stderr: (line) => { if (/error/i.test(line)) this.hud.telemetry(line.trim().slice(0, 200), 'error'); },
      ...(this.sessionId ? { resume: this.sessionId } : {}),
    };
  }

  async turn(text, retried = false) {
    const started = Date.now();
    let firstToken = null;
    let spoke = false;
    const speaker = new Sentences((s) => { spoke = true; this.hud.say(s); });
    const dispatched = new Map(); // Agent tool_use id → agent name
    this.hud.setState('thinking');

    const stamp = new Date().toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const q = query({ prompt: `[${stamp}] ${text}`, options: this.options() });
    this.current = q;
    let result = null;

    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          writeJson('session.json', { sessionId: this.sessionId });
          this.connectors = msg.mcp_servers || [];
          this.hud.broadcast({ type: 'connectors', connectors: this.connectors });
        } else if (msg.type === 'stream_event' && msg.parent_tool_use_id === null) {
          const ev = msg.event;
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            if (firstToken === null) firstToken = Date.now() - started;
            speaker.push(ev.delta.text);
          } else if (ev.type === 'content_block_stop') {
            speaker.flush();
          }
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type !== 'tool_use') continue;
            if (block.name === 'Agent' || block.name === 'Task') {
              const who = block.input.subagent_type || 'agent';
              dispatched.set(block.id, who);
              this.hud.setState('working', who);
              this.hud.telemetry(`${who} dispatched — ${block.input.description || ''}`, 'info');
            } else {
              const who = dispatched.get(msg.parent_tool_use_id) || 'vision';
              this.hud.telemetry(`${who} → ${nice(block.name)}`, 'dim');
            }
          }
        } else if (msg.type === 'user' && msg.parent_tool_use_id === null && Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_result' && dispatched.has(block.tool_use_id)) {
              this.hud.telemetry(`${dispatched.get(block.tool_use_id)} complete`, 'ok');
              this.hud.setState('thinking');
            }
          }
        } else if (msg.type === 'result') {
          result = msg;
        }
      }
    } finally {
      this.current = null;
    }
    speaker.flush();

    if (result?.is_error) {
      // A stale or missing session id is the usual cause after a reset: start clean once.
      if (this.sessionId && !retried && !spoke) {
        this.sessionId = null;
        writeJson('session.json', {});
        return this.turn(text, true);
      }
      const why = (result.errors || []).join('; ') || result.result || result.subtype;
      this.hud.telemetry(`Turn failed: ${String(why).slice(0, 300)}`, 'error');
      if (!spoke) this.hud.say('I could not complete that. The reason is in the telemetry log.');
    } else if (result && !spoke && typeof result.result === 'string' && result.result.trim()) {
      this.hud.say(result.result.trim());
    }

    const u = result?.usage || {};
    this.stats.turns += 1;
    this.stats.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
    this.stats.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    this.stats.latencyMs = firstToken ?? (Date.now() - started);
    this.hud.broadcast({ type: 'brain_stats', stats: this.stats });
    this.hud.setState('idle');
  }

  async reset() {
    this.sessionId = null;
    writeJson('session.json', {});
    this.stats = { turns: 0, tokens: 0, latencyMs: null, contextTokens: 0 };
    this.hud.broadcast({ type: 'brain_stats', stats: this.stats });
    this.hud.telemetry('Conversation reset', 'info');
  }
}
