// 离线自检：不读真实会话、不联网、不写任何东西到 home。
//
//   node scripts/selftest.mjs
//
// 重点是两条真踩过的坑：
//   1) DSH 会话文件是**追加写的多帧 zstd**，Node 的 zstdDecompressSync 只解第一帧
//      且不报错（实测 3.7MB 会话只读出一个事件）；
//   2) 卡片布局必须留出页脚预算，否则行数一多就和页脚叠在一起。

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { decompressZstd, listSessions, readCwd, readEvents, resolveSession } from '../src/session.mjs';
import { compactNumber, formatDuration, redactProject, renderSvg, renderText, shortId } from '../src/render.mjs';
import { computeStats, estimateCost } from '../src/stats.mjs';
import { aggregate, parseSince, withinWindow } from '../src/aggregate.mjs';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-selftest-'));

// ---------------------------------------------------------------- 多帧 zstd

{
  const line1 = JSON.stringify({ type: 'session', id: 'session-abc', cwd: '/Users/someone/project/demo' });
  const line2 = JSON.stringify({ type: 'tool/call', time: 1000, data: { name: 'bash', arguments: '{}' } });
  const single = zlib.zstdCompressSync(Buffer.from(`${line1}\n`));
  const second = zlib.zstdCompressSync(Buffer.from(`${line2}\n`));
  const multi = Buffer.concat([single, second]);

  check('单帧能解', decompressZstd(single).includes('session-abc'));
  const decoded = decompressZstd(multi);
  check('多帧全部解开（回归：只解第一帧的坑）', decoded.includes('session-abc') && decoded.includes('tool/call'), decoded.slice(0, 60));

  // 关键回归：Node 原生接口在多帧上只返回第一帧，且**不抛错**
  const native = zlib.zstdDecompressSync(multi).toString('utf8');
  check('原生接口确实只解第一帧（这正是要绕开它的原因）', native.includes('session-abc') && !native.includes('tool/call'));

  const dir = path.join(TMP, 'sessions', '--proj--', 'session-abc');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, multi);

  const events = readEvents(file);
  check('readEvents 走多帧路径拿到全部事件', events.length === 2, `实际 ${events.length}`);
  check('readCwd 从第一条事件取到 cwd', readCwd(file) === '/Users/someone/project/demo', String(readCwd(file)));

  // 坏行不该让整份战报失败
  const withBadLine = Buffer.concat([single, zlib.zstdCompressSync(Buffer.from('{坏行\n')), second]);
  fs.writeFileSync(file, withBadLine);
  check('坏行被跳过而不是抛错', readEvents(file).some((event) => event.type === 'unparsable'));
}

// ---------------------------------------------------------------- 会话定位

{
  const root = path.join(TMP, 'sessions');
  const list = listSessions(root, { limit: 10 });
  check('listSessions 找到会话', list.length === 1 && list[0].id === 'abc');
  check('resolveSession 支持 id 前缀', resolveSession('abc', root).id === 'abc');
  check('resolveSession 默认取最新', resolveSession(undefined, root).id === 'abc');
  let threw = false;
  try {
    resolveSession('zzz', root);
  } catch {
    threw = true;
  }
  check('找不到时报错而不是返回空', threw);
}

// ---------------------------------------------------------------- 统计口径

{
  const events = [
    { type: 'session', cwd: '/x' },
    { type: 'turn/start', time: 1000, data: { turn: 1 } },
    { type: 'step/start', time: 1100, data: { turn: 1, step: 1 } },
    { type: 'user/message', time: 1050, data: {} },
    { type: 'tool/call', time: 1200, data: { name: 'bash', arguments: '{"command":"ls"}' } },
    { type: 'tool/call', time: 1300, data: { name: 'write', arguments: '{"file_path":"/a/b/notes.md","content":"x"}' } },
    { type: 'tool/call', time: 1350, data: { name: 'edit', arguments: '{"file_path":"/a/b/notes.md","old_string":"x"}' } },
    { type: 'assistant/message', time: 1400, data: { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 5 } } },
    { type: 'assistant/message', time: 1500, data: { usage: { inputTokens: 50, outputTokens: 10 } } },
    { type: 'compaction/prune', time: 1600, data: { shadowedTokenCount: 1234 } },
    { type: 'request/header', time: 1700, data: { header: { config: { model: 'deepseek-flash' } } } },
  ];
  const stats = computeStats(events, { sessionId: 'abcdef123456', project: '/Users/someone/project/demo' });
  check('轮次/步数按去重计数', stats.turns === 1 && stats.steps === 1);
  check('工具调用计数正确', stats.toolCalls === 3);
  check('同名文件去重', stats.filesTouched === 1 && stats.files[0] === 'notes.md', JSON.stringify(stats.files));
  check('tokens 分开累加，缓存读不混进 input', stats.tokens.input === 150 && stats.tokens.output === 30 && stats.tokens.cacheRead === 900);
  check('压缩次数与被裁 token', stats.compactions === 1 && stats.prunedTokens === 1234);
  check('模型从 request/header 取', stats.models[0] === 'deepseek-flash');
  check('时长按首尾时间算', stats.durationMs === 700, String(stats.durationMs));

  const cost = estimateCost(stats.tokens, { priceIn: 2, priceOut: 8, priceCacheRead: 0.2 });
  const expected = (150 / 1e6) * 2 + (30 / 1e6) * 8 + (900 / 1e6) * 0.2;
  check('成本只在给单价时计算', Math.abs(cost.total - expected) < 1e-12, String(cost.total));
  check('不给单价就不编数字', estimateCost(stats.tokens, {}) === null);
}

// ---------------------------------------------------------------- 渲染与脱敏

{
  const stats = computeStats([
    { type: 'tool/call', time: 0, data: { name: 'bash', arguments: '{"command":"ls"}' } },
  ], { sessionId: 'deadbeefcafe1234', project: '/Users/yezhipeng/project/dsh-plugin' });

  check('项目名只留最后一段（不泄露用户名）', redactProject(stats.project) === 'dsh-plugin');
  check('会话 id 只显示前 8 位', shortId(stats.sessionId) === 'deadbeef');
  check('时长格式：分钟', formatDuration(59) === '59 分钟');
  check('时长格式：小时+分钟', formatDuration(80) === '1 小时 20 分');
  check('时长格式：不足一分钟', formatDuration(0) === '<1 分钟');
  check('中文大数：万级', compactNumber(236763, 'zh') === '23.7 万', compactNumber(236763, 'zh'));
  check('中文大数：亿级', compactNumber(236763392, 'zh') === '2.37 亿', compactNumber(236763392, 'zh'));
  check('英文大数用 M', compactNumber(236763392, 'en').endsWith('M'));

  const text = renderText(stats, { lang: 'zh' });
  check('文本战报不含绝对路径', !text.includes('/Users/'), text.slice(0, 80));

  const svg = renderSvg(stats, { lang: 'zh' });
  check('SVG 是合法开头结尾', svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>'));
  check('SVG 不含绝对路径', !svg.includes('/Users/'));
  check('SVG 尺寸正确', svg.includes('width="1080"') && svg.includes('height="1350"'));

  // 回归：行数多时不能压到页脚（第一版就叠在一起了）
  const manyTools = computeStats(
    Array.from({ length: 40 }, (_, index) => ({ type: 'tool/call', time: index, data: { name: `tool-${index}`, arguments: '{}' } })),
    { sessionId: 'x', project: 'p' },
  );
  const dense = renderSvg(manyTools, { lang: 'zh' });
  const textYs = [...dense.matchAll(/<text[^>]*y="(\d+)"/g)].map((match) => Number(match[1]));
  const footer = textYs[textYs.length - 1];
  const contentBeforeFooter = textYs.slice(0, -2);
  check('内容不会压到页脚上（布局预算生效）', Math.max(...contentBeforeFooter) < footer - 40, `最大 y=${Math.max(...contentBeforeFooter)} 页脚 y=${footer}`);

  const escaped = renderSvg(computeStats([], { sessionId: '<script>', project: 'a&b' }));
  check('SVG 文本做了转义', escaped.includes('&lt;script&gt;') && escaped.includes('a&amp;b'));
}


// ---------------------------------------------------------------- 周期聚合

{
  const now = new Date('2026-10-03T00:00:00Z').getTime();
  check('--since 7d 解析', parseSince('7d', now) === now - 7 * 86400000);
  check('--since 24h 解析', parseSince('24h', now) === now - 24 * 3600000);
  check('--since 30m 解析', parseSince('30m', now) === now - 30 * 60000);
  check('--since ISO 解析', parseSince('2026-10-01', now) === new Date('2026-10-01').getTime());
  check('--since 空值返回 null（不设窗口）', parseSince(undefined, now) === null);
  let threw = false;
  try {
    parseSince('下周', now);
  } catch {
    threw = true;
  }
  check('--since 看不懂就报错', threw);

  const inWindow = { lastAt: new Date(now - 3600000).toISOString() };
  const outWindow = { lastAt: new Date(now - 8 * 86400000).toISOString() };
  check('窗口判断：在内', withinWindow(inWindow, now - 86400000) === true);
  check('窗口判断：在外', withinWindow(outWindow, now - 86400000) === false);
  check('无窗口时全要', withinWindow(outWindow, null) === true);

  const a = computeStats([
    { type: 'turn/start', time: 1000, data: { turn: 1 } },
    { type: 'tool/call', time: 1100, data: { name: 'bash', arguments: '{}' } },
    { type: 'tool/call', time: 1200, data: { name: 'write', arguments: '{"file_path":"/x/a.md"}' } },
    { type: 'assistant/message', time: 1300, data: { usage: { inputTokens: 100, outputTokens: 10 } } },
  ], { sessionId: 's1', project: '/p/alpha' });
  const b = computeStats([
    { type: 'turn/start', time: 5000, data: { turn: 1 } },
    { type: 'tool/call', time: 5100, data: { name: 'bash', arguments: '{}' } },
    { type: 'tool/call', time: 5200, data: { name: 'write', arguments: '{"file_path":"/y/a.md"}' } },
    { type: 'assistant/message', time: 5300, data: { usage: { inputTokens: 200, outputTokens: 20 } } },
  ], { sessionId: 's2', project: '/p/beta' });

  const agg = aggregate([a, b]);
  check('聚合：会话数', agg.sessionCount === 2);
  check('聚合：项目去重', agg.projectCount === 2 && agg.projects.length === 2);
  check('聚合：轮次相加', agg.turns === 2);
  check('聚合：工具按名合并', agg.tools.find((t) => t.name === 'bash')?.count === 2);
  check('聚合：文件名并集去重（同名的 a.md 只算一次）', agg.filesTouched === 1, JSON.stringify(agg.files));
  check('聚合：tokens 相加', agg.tokens.input === 300 && agg.tokens.output === 30);
  check('聚合：时间跨度是首尾差，不是时长之和', agg.spanMs === 4300, String(agg.spanMs));
  check('聚合：时长合计单独保留', agg.durationMs === 300 + 300, String(agg.durationMs));
  check('聚合：空列表不炸', aggregate([]).sessionCount === 0);

  const text = renderText(agg, { lang: 'zh' });
  check('周期战报标题正确', text.startsWith('最近') || text.includes('周期战报'), text.split('\n')[0]);
  check('周期战报标明口径（含挂机/重复计算）', text.includes('重复计算'));
  const svg = renderSvg(agg, { lang: 'zh' });
  check('周期卡片是合法 SVG', svg.startsWith('<svg') && svg.includes('个会话'));
  check('周期卡片不含绝对路径', !svg.includes('/p/'));
}

// ---------------------------------------------------------------- 结果

fs.rmSync(TMP, { recursive: true, force: true });
if (failures.length > 0) {
  process.stderr.write(`✗ ${failures.length} 项失败 / 共 ${passed + failures.length} 项\n`);
  for (const item of failures) process.stderr.write(`  - ${item}\n`);
  process.exit(1);
}
process.stdout.write(`✅ 全部通过：${passed} 项（离线，未读真实会话）\n`);
