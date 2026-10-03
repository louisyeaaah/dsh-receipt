// 跨会话聚合：把一段时间里的多次会话合成一份「周期战报」。
//
// 为什么要有这个（和同名包的区别）：
//   npm 上的 dsh-receipt 做的是「每轮结束落一份审计凭据」——颗粒度到轮。
//   这里做的是另一个方向：**把一周/一个月的所有会话合成一张卡片**，
//   用于 build in public 的周期性汇报。
//
// 口径上必须诚实的两点：
//   1) 「时长合计」是把各会话的首尾差相加，多个会话并行时会大于真实墙上时间 ——
//      所以另外给出「时间跨度」（最早开始 → 最晚结束），两个都报，不混为一个数；
//   2) 「涉及文件」是并集去重，跨会话的同名文件只算一次。

import { computeStats } from './stats.mjs';

/** 解析 --since：支持 7d / 24h / 30m / ISO 日期。返回毫秒时间戳。 */
export function parseSince(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  const relative = /^(\d+)\s*(d|h|m)$/i.exec(String(value).trim());
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const factor = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
    return now - amount * factor;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`看不懂 --since ${value}（支持 7d / 24h / 30m / 2026-10-01）`);
  return parsed.getTime();
}

/** 这会话的最后活动时间是否落在窗口内。 */
export function withinWindow(stats, sinceMs) {
  if (sinceMs === null) return true;
  if (stats.lastAt === null) return false;
  return new Date(stats.lastAt).getTime() >= sinceMs;
}

/** 把多份 computeStats 结果合成一份。 */
export function aggregate(list, { label = null } = {}) {
  const sum = (pick) => list.reduce((total, stats) => total + (pick(stats) ?? 0), 0);
  const tools = new Map();
  const files = new Set();
  const projects = new Set();
  const models = new Set();
  const starts = [];
  const ends = [];

  for (const stats of list) {
    for (const tool of stats.tools) tools.set(tool.name, (tools.get(tool.name) ?? 0) + tool.count);
    for (const file of stats.files) files.add(file);
    if (typeof stats.project === 'string' && stats.project !== '') projects.add(stats.project);
    for (const model of stats.models) models.add(model);
    if (stats.firstAt !== null) starts.push(new Date(stats.firstAt).getTime());
    if (stats.lastAt !== null) ends.push(new Date(stats.lastAt).getTime());
  }

  const durationMs = sum((stats) => stats.durationMs);
  const spanMs = starts.length > 0 && ends.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0;

  return {
    label,
    sessionCount: list.length,
    sessionIds: list.map((stats) => stats.sessionId),
    projectCount: projects.size,
    projects: [...projects].sort(),
    models: [...models].sort(),
    firstAt: starts.length > 0 ? new Date(Math.min(...starts)).toISOString() : null,
    lastAt: ends.length > 0 ? new Date(Math.max(...ends)).toISOString() : null,
    durationMs,
    durationMinutes: Math.round(durationMs / 60000),
    spanMs,
    spanMinutes: Math.round(spanMs / 60000),
    turns: sum((stats) => stats.turns),
    steps: sum((stats) => stats.steps),
    userMessages: sum((stats) => stats.userMessages),
    assistantMessages: sum((stats) => stats.assistantMessages),
    toolCalls: sum((stats) => stats.toolCalls),
    tools: [...tools.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    filesTouched: files.size,
    files: [...files].sort(),
    tokens: {
      input: sum((stats) => stats.tokens.input),
      output: sum((stats) => stats.tokens.output),
      cacheRead: sum((stats) => stats.tokens.cacheRead),
      cacheWrite: sum((stats) => stats.tokens.cacheWrite),
    },
    compactions: sum((stats) => stats.compactions),
    prunedTokens: sum((stats) => stats.prunedTokens),
  };
}

/** 读一批会话文件并聚合。files 是 [{ id, project, file }]。 */
export function aggregateFiles(files, readEvents, { label = null, sinceMs = null } = {}) {
  const perSession = [];
  for (const item of files) {
    const stats = computeStats(readEvents(item.file), { sessionId: item.id, project: item.project });
    if (withinWindow(stats, sinceMs)) perSession.push(stats);
  }
  return { aggregate: aggregate(perSession, { label }), sessions: perSession };
}
