import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { args, changeKeys, cli, fields, jsonl, modelKey, print, proxies, record, requireThat, seconds, sum, tokenKeys } from './record.mjs';

const usageKeys = { in: 'input', out: 'output', reasoning: 'reasoning', cached: 'cacheRead' };
const timestamp = x => typeof x === 'string' ? Date.parse(x) : Number.isFinite(x) ? x : NaN;

export function spriteOutcome(rc, stopReason) {
  if (rc === 0) return stopReason === 'error' ? { state: 'failed', reason: 'model_error' } : { state: 'done', reason: null };
  if ([130, 137, 143].includes(rc)) return { state: 'canceled', reason: null };
  return { state: 'failed', reason: ({ 124: 'timeout', 125: 'idle' })[rc] ?? `exit ${rc}` };
}

function activeTime(start, end, tools) {
  const intervals = [];
  for (const { result, durationMs } of tools.values()) {
    const at = timestamp(result?.timestamp), duration = result?.durationMs ?? durationMs;
    if (!Number.isFinite(at) || !Number.isFinite(duration) || duration < 0) return null;
    const lo = Math.max(start, at - duration), hi = Math.min(end, at);
    if (lo < hi) intervals.push([lo, hi]);
  }
  let active = end - start, cursor = start;
  for (const [lo, hi] of intervals.sort((a, b) => a[0] - b[0])) {
    active -= Math.max(0, hi - Math.max(cursor, lo));
    cursor = Math.max(cursor, hi);
  }
  return seconds(active);
}

export function parseSprite(text, o) {
  const models = new Map(), tools = new Map(), seen = new Set();
  let start, end = -Infinity, current, thinking = null, stopReason;
  for (const e of jsonl(text)) {
    const m = e.message;
    const messages = [m, ...(e.toolResults ?? []), ...(e.messages ?? [])];
    for (const t of [e.timestamp, ...messages.map(x => x?.timestamp)].map(timestamp)) {
      if (Number.isFinite(t)) end = Math.max(end, t);
    }
    if (e.type === 'session') start ??= timestamp(e.timestamp);
    if (e.type === 'thinking_level_change') thinking = e.thinkingLevel ?? null;
    if (e.type === 'message_end' && m?.role === 'assistant') {
      const model = { provider: m.provider, name: m.model };
      requireThat(typeof model.provider === 'string' && typeof model.name === 'string');
      const key = modelKey(model);
      if (!models.has(key)) models.set(key, { model, turns: [], toolCalls: 0 });
      current = models.get(key);
      const id = m.responseId || JSON.stringify([m.provider, m.model, m.timestamp, m.usage?.totalTokens]);
      if (!seen.has(id)) {
        current.turns.push(m);
        stopReason = m.stopReason;
        seen.add(id);
      }
    }
    if (e.type === 'tool_execution_start' || e.type === 'tool_execution_end') {
      if (!tools.has(e.toolCallId)) tools.set(e.toolCallId, { owner: current });
      const tool = tools.get(e.toolCallId);
      if (e.type === 'tool_execution_end' && !tool.ended) {
        if (e.toolCallId != null && (tool.owner ?? current)) (tool.owner ?? current).toolCalls++;
        Object.assign(tool, { ended: true, durationMs: e.durationMs });
      }
    }
    for (const result of messages.filter(x => x?.role === 'toolResult')) {
      if (!tools.has(result.toolCallId)) tools.set(result.toolCallId, { owner: current });
      const tool = tools.get(result.toolCallId);
      if (!tool.result || e.type === 'message_end') tool.result = result;
    }
  }
  requireThat(Number.isFinite(start) && end >= start);
  const activeSeconds = activeTime(start, end, tools);
  return [...models.values()].map(({ model, turns, toolCalls }, i) => {
    const r = record(o, models.size === 1 ? o.name : `${o.name}~${i + 1}`, 'sprite', start, end);
    const tokens = fields(tokenKeys, k => sum(turns, m => m.usage?.[usageKeys[k]]));
    const costs = turns.map(m => m.usage?.cost?.total);
    const coverage = !Object.values(tokens).some(Number.isFinite) ? 'none'
      : turns.every(m => Object.values(usageKeys).every(k => Number.isFinite(m.usage?.[k]))) ? 'complete' : 'partial';
    return { ...r, model, thinking: turns.at(-1)?.thinkingLevel ?? thinking, activeSeconds,
      turns: turns.length, toolCalls, tokens, coverage: { tokens: coverage },
      costMicros: costs.length && costs.every(Number.isFinite) ? Math.round(sum(costs, x => x) * 1e6) : null,
      outcome: o.outcome === 'blocked' ? r.outcome : spriteOutcome(o.rc, stopReason), changes: o.changes ?? null,
      complexity: { rating: o.rating ?? null, proxies: proxies(o.changes, r.reviewRounds, o.failedChecks ?? null, o.retries ?? null) } };
  });
}

function main() {
  const [o, names] = args('dir worktree base', ['blocked']);
  requireThat(names.length === 1 && /^[\w.-]+$/.test(names[0]) && !/^\.+$/.test(names[0]));
  requireThat(Boolean(o.worktree) === Boolean(o.base) && !o.base?.startsWith('-'));
  const prefix = join(o.dir ?? join(sep, 'tmp', 'sprites'), names[0]);
  const text = readFileSync(`${prefix}.jsonl`, 'utf8');
  let rc;
  try { rc = readFileSync(`${prefix}.rc`, 'utf8').trim(); }
  catch (e) { if (e.code === 'ENOENT') return 3; throw e; }
  requireThat(/^-?\d+$/.test(rc) && Number.isSafeInteger(Number(rc)));
  let retries = null, changes = null;
  try { retries = readdirSync(prefix, { withFileTypes: true }).filter(e => e.isFile()).length - 1; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (o.base) {
    const stat = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--shortstat', o.base, '--'], {
      cwd: o.worktree, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const counts = [/\d+(?= files? changed)/, /\d+(?= insertions?\()/, /\d+(?= deletions?\()/];
    changes = fields(changeKeys, k => Number(stat.match(counts[changeKeys.indexOf(k)])?.[0] ?? 0));
  }
  print(parseSprite(text, { ...o, name: names[0], rc: Number(rc), retries, changes }));
  return 0;
}
cli(import.meta.url, main, 'error: invalid sprite arguments, log, or worktree');
