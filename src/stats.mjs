// 把会话事件算成「战报」事实。纯函数，不碰文件系统 —— 这样能离线测。
//
// 口径（必须写清楚，否则数字会被质疑造假）：
//   时长     第一个事件到最后一个事件的时间差（不是「我坐在电脑前的时间」）
//   轮次     用户的一次输入算一轮（turn/start 的去重计数）
//   步数     模型的一次响应算一步（step/start 的去重计数）
//   工具调用 tool/call 事件条数，按工具名分组
//   涉及文件 从工具参数里抽出的文件（同名去重，只用 basename）
//   tokens    assistant/message 上的 usage 累加；缓存读单独列出，不混进 input
//   上下文压力 compaction/prune 的次数，以及被裁掉的 token 数

const PATHY_KEYS = new Set(['file_path', 'path', 'file', 'target', 'notebook_path', 'cwd']);

function basename(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/["'`]/g, '').trim();
  if (cleaned === '' || cleaned.startsWith('-')) return null;
  const parts = cleaned.split('/');
  const name = parts[parts.length - 1];
  if (name === '' || name === '.' || name === '..') return null;
  return name.slice(0, 80);
}

/** 从一次工具调用的参数里抽文件（尽量保守：只认明确的路径字段）。 */
function filesFromCall(name, args) {
  const out = [];
  for (const [key, value] of Object.entries(args ?? {})) {
    if (PATHY_KEYS.has(key)) {
      const name_ = basename(value);
      if (name_ !== null) out.push(name_);
      continue;
    }
    // edit/write 这类：参数里带 file_path/path 才有意义，其余键不看
  }
  return out;
}

export function computeStats(events, { sessionId = null, project = null } = {}) {
  const tools = new Map();
  const turns = new Set();
  const steps = new Set();
  const files = new Set();
  const models = new Set();
  let toolCalls = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let firstTime = null;
  let lastTime = null;
  let compactions = 0;
  let prunedTokens = 0;
  let unparsable = 0;

  for (const event of events) {
    const type = event?.type;
    const data = event?.data ?? {};
    const time = event?.time;
    if (typeof time === 'number') {
      firstTime = firstTime === null ? time : Math.min(firstTime, time);
      lastTime = lastTime === null ? time : Math.max(lastTime, time);
    }
    if (type === 'unparsable') {
      unparsable += 1;
      continue;
    }
    if (type === 'tool/call') {
      toolCalls += 1;
      const name = typeof data.name === 'string' ? data.name : '?';
      tools.set(name, (tools.get(name) ?? 0) + 1);
      let args = null;
      if (typeof data.arguments === 'string') {
        try {
          args = JSON.parse(data.arguments);
        } catch {
          args = null;
        }
      } else if (data.arguments !== null && typeof data.arguments === 'object') {
        args = data.arguments;
      }
      for (const file of filesFromCall(name, args)) files.add(file);
      continue;
    }
    if (type === 'turn/start') {
      turns.add(String(data.turn ?? turns.size + 1));
      continue;
    }
    if (type === 'step/start') {
      steps.add(`${data.turn ?? '?'}:${data.step ?? steps.size}`);
      continue;
    }
    if (type === 'user/message') {
      userMessages += 1;
      continue;
    }
    if (type === 'assistant/message') {
      assistantMessages += 1;
      const usage = data.usage ?? {};
      inputTokens += Number(usage.inputTokens ?? 0);
      outputTokens += Number(usage.outputTokens ?? 0);
      cacheReadTokens += Number(usage.cacheReadTokens ?? 0);
      cacheWriteTokens += Number(usage.cacheWriteTokens ?? 0);
      continue;
    }
    if (type === 'compaction/prune') {
      compactions += 1;
      prunedTokens += Number(data.shadowedTokenCount ?? 0);
      continue;
    }
    if (type === 'request/header') {
      const config = data.header?.config;
      if (typeof config?.model === 'string') models.add(config.model);
      continue;
    }
  }

  const durationMs = firstTime !== null && lastTime !== null ? lastTime - firstTime : 0;
  const toolList = [...tools.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    sessionId,
    project,
    firstAt: firstTime === null ? null : new Date(firstTime).toISOString(),
    lastAt: lastTime === null ? null : new Date(lastTime).toISOString(),
    durationMs,
    durationMinutes: Math.round(durationMs / 60000),
    turns: turns.size,
    steps: steps.size,
    userMessages,
    assistantMessages,
    toolCalls,
    tools: toolList,
    filesTouched: files.size,
    files: [...files].sort(),
    tokens: { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens },
    compactions,
    prunedTokens,
    models: [...models],
    unparsable,
  };
}

/**
 * 成本估算。**只在调用方给了单价时才算** —— 不内置价目表，
 * 因为价格会变、编一个数字比不给更糟。
 */
export function estimateCost(tokens, { priceIn = null, priceOut = null, priceCacheRead = null } = {}) {
  if (priceIn === null && priceOut === null) return null;
  const perMillion = (count, price) => (price === null ? 0 : (count / 1_000_000) * price);
  const input = perMillion(tokens.input, priceIn);
  const output = perMillion(tokens.output, priceOut);
  const cache = perMillion(tokens.cacheRead, priceCacheRead);
  return { input, output, cache, total: input + output + cache, currency: 'USD' };
}
