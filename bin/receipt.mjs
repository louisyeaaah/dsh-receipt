#!/usr/bin/env node
// dsh-receipt —— 把一次 DSH 会话变成一张可发布的战报。零依赖。
//
//   dsh-receipt                          最新一次会话，打印文本战报
//   dsh-receipt --list                   列出最近会话
//   dsh-receipt <id前缀>                 指定会话
//   dsh-receipt --svg out.svg            输出可发布卡片（1080×1350）
//   dsh-receipt --png out.png            先出 SVG 再用本地 Chrome 转 PNG
//   dsh-receipt --json                   机器可读
//   dsh-receipt --lang en                英文
//   dsh-receipt --show-paths             不脱敏（显示完整项目路径）
//   dsh-receipt --price-in 2 --price-out 8 [--price-cache 0.2]
//                                        给了单价才估成本（每百万 token 的美元价）
//
// 只读：不写会话文件、不改任何配置。唯一的写操作是你用 --svg/--png 指定的输出文件。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { readEvents, resolveSession, listSessions, SESSIONS_ROOT } from '../src/session.mjs';
import { aggregateFiles, parseSince } from '../src/aggregate.mjs';
import { computeStats, estimateCost } from '../src/stats.mjs';
import { formatDuration, renderSvg, renderText, shortId } from '../src/render.mjs';

const VERSION = '0.1.0';

function parseArgs(argv) {
  const flags = { lang: 'zh', json: false, svg: null, png: null, list: false, showPaths: false, theme: 'dark', priceIn: null, priceOut: null, priceCache: null, help: false, since: null, project: null, limit: 500 };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lang') flags.lang = String(argv[++index] ?? 'zh');
    else if (arg === '--json') flags.json = true;
    else if (arg === '--svg') flags.svg = String(argv[++index] ?? 'receipt.svg');
    else if (arg === '--png') flags.png = String(argv[++index] ?? 'receipt.png');
    else if (arg === '--list') flags.list = true;
    else if (arg === '--show-paths') flags.showPaths = true;
    else if (arg === '--theme') flags.theme = String(argv[++index] ?? 'dark');
    else if (arg === '--price-in') flags.priceIn = Number(argv[++index]);
    else if (arg === '--price-out') flags.priceOut = Number(argv[++index]);
    else if (arg === '--price-cache') flags.priceCache = Number(argv[++index]);
    else if (arg === '--since') flags.since = String(argv[++index] ?? '');
    else if (arg === '--project') flags.project = String(argv[++index] ?? '');
    else if (arg === '--limit') flags.limit = Number(argv[++index] ?? 500);
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--version') flags.version = true;
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    else positional.push(arg);
  }
  return { flags, positional };
}

const USAGE = `dsh-receipt ${VERSION} —— 把一次 DSH 会话变成一张可发布的战报（零依赖、只读）

用法
  dsh-receipt [会话id前缀] [选项]

选项
  --list                列出最近的会话
  --svg <文件>          输出可发布卡片（SVG，1080×1350）
  --png <文件>          输出 PNG（用本机 Chrome 把 SVG 转出来）
  --json                输出机器可读结果
  --lang zh|en          语言（默认 zh）
  --theme dark|light    卡片配色（默认 dark）
  --show-paths          不脱敏，显示完整项目路径
  --price-in/-out/-cache <每百万token美元价>   给了才估成本
  --since <7d|24h|2026-10-01>   出「周期战报」：把窗口内所有会话合成一份
  --project <名字>              只统计某个项目（配合 --since）
  --limit <n>                   --since 时最多读多少个会话（默认 500）

会话日志目录：${SESSIONS_ROOT}（可用 DSH_RECEIPT_SESSIONS 覆盖）
`;

/** 用本机 Chrome 把 SVG 转成 PNG。找不到 Chrome 就如实报错，不静默失败。 */
function svgToPng(svgFile, pngFile) {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  const chrome = candidates.find((item) => fs.existsSync(item));
  if (chrome === undefined) {
    throw new Error(`没找到 Chrome/Chromium，无法转 PNG。SVG 已经写好了：${svgFile}（可直接拖进浏览器或发 X）`);
  }
  const result = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--screenshot=${path.resolve(pngFile)}`,
    '--window-size=1080,1350',
    `file://${path.resolve(svgFile)}`,
  ], { stdio: 'ignore', timeout: 60000 });
  if (result.status !== 0 || !fs.existsSync(pngFile)) {
    throw new Error(`Chrome 转 PNG 失败（退出码 ${result.status}）。SVG 仍然可用：${svgFile}`);
  }
  return pngFile;
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (flags.list) {
    const sessions = listSessions(SESSIONS_ROOT, { limit: 20 });
    if (sessions.length === 0) {
      process.stdout.write('没有任何会话。\n');
      return;
    }
    for (const item of sessions) {
      const kb = Math.round(item.bytes / 1024);
      process.stdout.write(`${shortId(item.id)}  ${item.modifiedAt.slice(0, 16).replace('T', ' ')}  ${String(kb).padStart(6)}KB  ${flags.showPaths ? item.project : item.project.split('/').slice(-1)[0]}\n`);
    }
    return;
  }

  // --since 走聚合：把窗口内的所有会话合成一份周期战报
  if (flags.since !== null && positional[0] === undefined) {
    const sinceMs = parseSince(flags.since);
    let files = listSessions(SESSIONS_ROOT, { limit: flags.limit });
    if (flags.project !== null && flags.project !== '') {
      const needle = String(flags.project);
      files = files.filter((item) => item.project === needle || item.project.endsWith(`/${needle}`) || item.project.endsWith(needle));
    }
    const { aggregate, sessions } = aggregateFiles(files, readEvents, { sinceMs, label: flags.since });
    if (sessions.length === 0) {
      process.stdout.write(`窗口内（--since ${flags.since}）没有会话。\n`);
      return;
    }
    const cost = estimateCost(aggregate.tokens, { priceIn: flags.priceIn, priceOut: flags.priceOut, priceCacheRead: flags.priceCache });
    const title = flags.lang === 'en' ? `LAST ${String(flags.since).toUpperCase()}` : `最近 ${flags.since} 战报`;
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ version: VERSION, since: flags.since, window: { sinceMs }, sessionFiles: sessions.length, aggregate, cost }, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderText(aggregate, { lang: flags.lang, cost, showPaths: flags.showPaths, title })}\n`);
    }
    if (flags.svg !== null || flags.png !== null) {
      const svgFile = flags.svg ?? flags.png.replace(/\.png$/i, '.svg');
      fs.mkdirSync(path.dirname(path.resolve(svgFile)), { recursive: true });
      fs.writeFileSync(svgFile, renderSvg(aggregate, { lang: flags.lang, cost, theme: flags.theme, title }));
      process.stdout.write(`\n卡片已写入：${svgFile}\n`);
      if (flags.png !== null) process.stdout.write(`PNG 已写入：${svgToPng(svgFile, flags.png)}\n`);
    }
    return;
  }

  const target = resolveSession(positional[0], SESSIONS_ROOT);
  const events = readEvents(target.file);
  const stats = computeStats(events, { sessionId: target.id, project: target.project });
  const cost = estimateCost(stats.tokens, { priceIn: flags.priceIn, priceOut: flags.priceOut, priceCacheRead: flags.priceCache });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ version: VERSION, session: { id: target.id, file: target.file }, stats, cost }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderText(stats, { lang: flags.lang, cost, showPaths: flags.showPaths })}\n`);
  }

  if (flags.svg !== null || flags.png !== null) {
    const svg = renderSvg(stats, { lang: flags.lang, cost, theme: flags.theme });
    const svgFile = flags.svg ?? flags.png.replace(/\.png$/i, '.svg');
    fs.mkdirSync(path.dirname(path.resolve(svgFile)), { recursive: true });
    fs.writeFileSync(svgFile, svg);
    process.stdout.write(`\n卡片已写入：${svgFile}\n`);
    if (flags.png !== null) {
      const png = svgToPng(svgFile, flags.png);
      process.stdout.write(`PNG 已写入：${png}\n`);
    }
  }
}

// 管道被下游关掉（| head / | tail）时不要甩一堆栈：安静退出。
// 这是 CLI 的常见用法，第一版没处理，实测直接崩了。
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`\n✗ ${error.message}\n`);
  process.exit(1);
}
