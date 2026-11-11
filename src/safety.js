// The zero-trust layer: every tool call from the brain or an agent lands here.
//   read-only            → allowed
//   matches rules.json   → allowed (a rule the user verified) or denied
//   anything else        → a human signs off in the HUD, or it does not happen
//   Scout                → never allowed to change anything, sign-off or not
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, appendLine } from './config.js';

const READ_VERBS = new Set(['get', 'list', 'search', 'read', 'query', 'fetch', 'find', 'view', 'show',
  'check', 'describe', 'lookup', 'recall', 'count', 'download', 'suggest', 'whoami', 'export']);
const BUILTIN_READ = new Set(['StructuredOutput', 'WebSearch', 'WebFetch', 'Agent', 'Task', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export function isReadOnly(toolName) {
  if (BUILTIN_READ.has(toolName)) return true;
  const m = toolName.match(/^mcp__.+?__(.+)$/);
  if (!m) return false; // unknown built-in (Bash, Write, …): never silently
  const words = m[1].toLowerCase().split(/[_\-.]+/).filter(Boolean);
  return words.slice(0, 2).some((w) => READ_VERBS.has(w));
}

function loadRules() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'rules.json'), 'utf8')); }
  catch { return {}; }
}
const matches = (patterns, name) => (patterns || []).some((p) =>
  p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : p === name);

const pretty = (toolName) => {
  const m = toolName.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[2].replace(/_/g, ' ')} (${m[1].replace(/_/g, ' ')})` : toolName;
};

export class SafetyGate {
  /** @param {{broadcast: Function, telemetry: Function, say: Function}} hud */
  constructor(hud) {
    this.hud = hud;
    this.pending = new Map();   // approval id → {resolve, card}
    this.agentTypes = new Map(); // subagent instance id → 'scout' | 'operator' | 'advisor'
    this.decisions = new Map();  // tool_use id → Promise<{allow, message?}>
  }

  noteAgent(agentId, agentType) { this.agentTypes.set(agentId, agentType); }

  /**
   * The single decision point. Memoised per tool call, because the same call is
   * seen twice: by the PreToolUse hook and, if it falls through, by canUseTool.
   */
  decide(toolName, input, agent, toolUseID, title) {
    if (isReadOnly(toolName)) return Promise.resolve({ allow: true });
    if (this.decisions.has(toolUseID)) return this.decisions.get(toolUseID);
    const p = this.judge(toolName, input, agent, title);
    this.decisions.set(toolUseID, p);
    if (this.decisions.size > 500) this.decisions.delete(this.decisions.keys().next().value);
    return p;
  }

  async judge(toolName, input, agent, title) {
    const rules = loadRules();
    const record = (outcome) => appendLine('operator-log.jsonl',
      { at: new Date().toISOString(), agent, tool: toolName, input, outcome });

    if (agent === 'scout' || agent === 'advisor') {
      record('refused: read-only agent');
      this.hud.telemetry(`${agent} blocked from ${pretty(toolName)} — read-only`, 'warn');
      return { allow: false, message: `The ${agent} is read-only and cannot change anything. Report this as UNAVAILABLE.` };
    }
    if (matches(rules.alwaysDeny, toolName)) {
      record('refused: rule');
      return { allow: false, message: 'The user has forbidden this action in rules.json.' };
    }
    if (matches(rules.autoApprove, toolName)) {
      record('done: verified rule');
      this.hud.telemetry(`${agent}: ${pretty(toolName)} — verified rule`, 'ok');
      return { allow: true };
    }
    const allow = await this.askHuman({ agent, toolName, input, title });
    record(allow ? 'done: human sign-off' : 'refused: human declined');
    this.hud.telemetry(`${agent}: ${pretty(toolName)} — ${allow ? 'approved' : 'declined'}`, allow ? 'ok' : 'warn');
    return allow ? { allow: true }
      : { allow: false, message: 'The user declined this action. Do not retry it; tell them it was not done.' };
  }

  /**
   * PreToolUse hook: runs before every tool call, ahead of any allow rule in the
   * user's own Claude Code settings, so nothing can skip the gate. `fixedAgent`
   * pins the caller for patrol runs.
   */
  hook(fixedAgent) {
    return {
      PreToolUse: [{
        timeout: APPROVAL_TIMEOUT_MS / 1000 + 30,
        onFailure: 'block',
        hooks: [async (input) => {
          // Reads are allowed outright, so an agent never stalls on a prompt nobody can see.
          if (isReadOnly(input.tool_name)) {
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Read-only.' } };
          }
          const agent = fixedAgent || input.agent_type || 'vision';
          const d = await this.decide(input.tool_name, input.tool_input, agent, input.tool_use_id);
          return { hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: d.allow ? 'allow' : 'deny',
            permissionDecisionReason: d.message || 'Signed off.',
          } };
        }],
      }],
    };
  }

  /** `canUseTool`: the fallback for anything that reaches the normal permission prompt. */
  handler(fixedAgent) {
    return async (toolName, input, opts) => {
      const agent = fixedAgent || this.agentTypes.get(opts.agentID) || 'vision';
      const d = await this.decide(toolName, input, agent, opts.toolUseID, opts.title);
      return d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: d.message };
    };
  }

  askHuman({ agent, toolName, input, title }) {
    const id = crypto.randomUUID();
    const card = { id, agent, tool: toolName, title: title || `${agent} wants to ${pretty(toolName)}`, input };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.resolve(id, false), APPROVAL_TIMEOUT_MS);
      this.pending.set(id, { card, resolve: (v) => { clearTimeout(timer); resolve(v); } });
      this.hud.broadcast({ type: 'approval', card });
      this.hud.say(`I need your sign-off to ${pretty(toolName).replace(/\s*\(.*\)$/, '')}.`);
    });
  }

  resolve(id, allow) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.hud.broadcast({ type: 'approval_done', id });
    p.resolve(Boolean(allow));
  }

  pendingCards() { return [...this.pending.values()].map((p) => p.card); }
}
