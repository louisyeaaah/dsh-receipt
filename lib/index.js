// dsh-receipt 的插件层：让它在 DSH 里也能直接用。
//
//   dsh_receipt()                     当前会话的战报（文本）
//   dsh_receipt({ scope: 'period', since: '7d' })   最近 7 天汇总
//   dsh_receipt({ format: 'svg', out: '/tmp/card.svg' })  出可发布的卡片
//   /dsh-receipt                      人也可以直接敲
//
// 为什么要插件层：命令行版只能在自己机器上跑，装进 DSH 之后
//   ① agent 可以在会话里顺手出一张战报；
//   ② 仓库才有资格被插件市场收录（市场要求 package.json 声明 dsh.bundle）。
//
// 只读：不写会话文件；唯一的写操作是调用方显式给 out 时写出的那张卡片。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { CommandDefinitionId } from '@deepseek-ai/dsh-commands';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { aggregateFiles, parseSince } from '../src/aggregate.mjs';
import { renderSvg, renderText } from '../src/render.mjs';
import { listSessions, locateSession, readEvents } from '../src/session.mjs';
import { computeStats, estimateCost } from '../src/stats.mjs';

export const name = 'dsh-receipt';

/** 只硬依赖工具注册表；commands 是可选的。 */
export const inject = ['tools'];

export const Config = z.object({
  /** 默认语言。 */
  lang: z.union([z.const('zh'), z.const('en')]).default('zh'),
  /** 默认读取会话的根目录（默认 ~/.dsh/sessions）。 */
  sessionsRoot: z.string().default(''),
});

const VERSION = '0.1.0';

function buildReport(ctx, { cwd, scope, since, lang, format, out, showPaths, priceIn, priceOut, sessionsRoot }) {
  const root = sessionsRoot !== '' ? sessionsRoot : undefined;
  const costOptions = { priceIn: priceIn ?? null, priceOut: priceOut ?? null };
  if (scope === 'period') {
    const sinceMs = parseSince(since ?? '7d');
    const files = listSessions(root, { limit: 500 });
    const { aggregate, sessions } = aggregateFiles(files, readEvents, { sinceMs });
    if (sessions.length === 0) return { text: `窗口内（${since ?? '7d'}）没有会话。`, facts: null };
    const cost = estimateCost(aggregate.tokens, costOptions);
    const title = lang === 'en' ? `LAST ${String(since ?? '7d').toUpperCase()}` : `最近 ${since ?? '7d'} 战报`;
    return { text: renderText(aggregate, { lang, cost, showPaths, title }), facts: aggregate, svg: renderSvg(aggregate, { lang, cost, title }) };
  }
  const target = locateSession(cwd, { root });
  const stats = computeStats(readEvents(target.file), { sessionId: target.id, project: target.project });
  const cost = estimateCost(stats.tokens, costOptions);
  return { text: renderText(stats, { lang, cost, showPaths }), facts: stats, svg: renderSvg(stats, { lang, cost }) };
}

function writeCard(path, svg) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, svg);
  return path;
}

export function apply(ctx, config) {
  const settings = {
    lang: config.lang === 'en' ? 'en' : 'zh',
    sessionsRoot: typeof config.sessionsRoot === 'string' && config.sessionsRoot !== '' ? config.sessionsRoot : '',
  };

  ctx.tools.register(defineTool({
    name: 'dsh_receipt',
    description: '把一次会话（或一段时间）变成一张可发布的战报：时长、轮次、步数、工具调用、'
      + '涉及文件、tokens、上下文压缩压力。数字全部从会话日志里读，**默认脱敏**'
      + '（项目名只留最后一段、文件只留文件名）。只读，不写会话文件；'
      + '只有显式给 out 时才写出一张 SVG 卡片。',
    parameters: {
      scope: { type: 'string', enum: ['session', 'period'], description: 'session=当前会话（默认）；period=一段时间汇总' },
      since: { type: 'string', description: "period 用：7d / 24h / 30m / ISO 日期。默认 7d" },
      lang: { type: 'string', enum: ['zh', 'en'], description: '语言，默认跟插件配置' },
      out: { type: 'string', description: '可选：把卡片写成 SVG 的绝对路径' },
      showPaths: { type: 'boolean', description: '设为 true 时显示完整项目路径（默认脱敏）' },
      priceIn: { type: 'number', description: '可选：每百万输入 token 的美元价（给了才估成本）' },
      priceOut: { type: 'number', description: '可选：每百万输出 token 的美元价' },
    },
    timeoutMs: 120000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string', required: true },
          cardPath: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.cardPath === undefined ? value.report : `${value.report}\n\n卡片已写入：${value.cardPath}` }],
    },
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      const lang = args.lang === 'en' || args.lang === 'zh' ? args.lang : settings.lang;
      const built = buildReport(ctx, {
        cwd,
        scope: args.scope === 'period' ? 'period' : 'session',
        since: args.since,
        lang,
        format: args.out === undefined ? 'text' : 'svg',
        out: args.out,
        showPaths: args.showPaths === true,
        priceIn: args.priceIn,
        priceOut: args.priceOut,
        sessionsRoot: settings.sessionsRoot,
      });
      let cardPath;
      if (args.out !== undefined && built.svg !== undefined) cardPath = writeCard(String(args.out), built.svg);
      return cardPath === undefined ? { report: built.text } : { report: built.text, cardPath };
    },
  }));

  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      definitionId: CommandDefinitionId('dsh-receipt'),
      name: 'dsh-receipt',
      description: '出当前会话的战报（加 period 7d 看一段时间汇总）',
      input: { hint: '[period 7d] [en] [out:/tmp/card.svg]' },
      handler: async (invocation) => {
        const raw = (invocation.rawInput ?? '').trim();
        const parts = raw.split(/\s+/).filter(Boolean);
        const cwd = invocation.agent?.session?.header?.cwd ?? process.cwd();
        const outArg = parts.find((part) => part.startsWith('out:'));
        const built = buildReport(scoped, {
          cwd,
          scope: parts.includes('period') ? 'period' : 'session',
          since: parts.find((part) => /^\d+(d|h|m)$/i.test(part)) ?? '7d',
          lang: parts.includes('en') ? 'en' : settings.lang,
          format: outArg === undefined ? 'text' : 'svg',
          out: outArg?.slice(4),
          showPaths: false,
          sessionsRoot: settings.sessionsRoot,
        });
        let text = built.text;
        if (outArg !== undefined && built.svg !== undefined) {
          text += `\n\n卡片已写入：${writeCard(outArg.slice(4), built.svg)}`;
        }
        return { kind: 'success', text: `${text}\n\n— dsh-receipt v${VERSION}` };
      },
    });
  });
}
