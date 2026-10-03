// 读取 DSH 会话日志。
//
// 会话文件是 ~/.dsh/sessions/<项目目录转义>/session-<uuid>/session.v4.jsonl.zstd：
// zstd 压缩的 JSONL，每行一个事件。Node ≥ 22 自带 zlib.zstdDecompressSync，
// 所以整个工具零依赖。
//
// 只读：这个模块不写任何文件、不改任何会话数据。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

export const SESSIONS_ROOT = process.env.DSH_RECEIPT_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions');
export const SESSION_FILE = 'session.v4.jsonl.zstd';

/** zstd 帧魔数（小端 0xFD2FB528）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 解 zstd —— 关键是 DSH 的会话文件是**追加写的多帧 zstd**。
 *
 * Node 的 zstdDecompressSync / createZstdDecompress 只解第一帧（实测：3.7MB 的会话
 * 只读出一个事件，流式接口还会报 "Unknown frame descriptor"）。
 * 所以这里按帧魔数切分、逐帧解，保持零依赖。
 */
export function decompressZstd(buffer) {
  const offsets = [];
  let cursor = buffer.indexOf(ZSTD_MAGIC, 0);
  while (cursor >= 0) {
    offsets.push(cursor);
    cursor = buffer.indexOf(ZSTD_MAGIC, cursor + 4);
  }
  if (offsets.length === 0) throw new Error('不是 zstd 数据（找不到帧头）');
  if (offsets.length === 1) {
    // 单帧：快路径。注意不能拿多帧 buffer 走这里 ——
    // zstdDecompressSync 遇到后续帧既不报错也不继续解，只会静默返回第一帧。
    return zlib.zstdDecompressSync(buffer).toString('utf8');
  }
  const boundaries = offsets[0] === 0 ? offsets : [0, ...offsets];
  const parts = [];
  let start = 0;
  while (start < boundaries.length) {
    // 从 start 开始，向后找到第一个能解开的边界（魔数也可能巧合出现在压缩数据里，
    // 解不开就多吃一段再试）
    let end = start + 1;
    let decoded = null;
    while (end <= boundaries.length) {
      const slice = buffer.subarray(boundaries[start], end < boundaries.length ? boundaries[end] : buffer.length);
      try {
        decoded = zlib.zstdDecompressSync(slice).toString('utf8');
        break;
      } catch {
        end += 1;
      }
    }
    if (decoded === null) {
      // 剩下的解不开：不静默丢，交给调用方看到「有坏帧」
      parts.push('');
      break;
    }
    parts.push(decoded);
    start = end;
  }
  return parts.join('');
}

/** 一个会话文件的可读信息。 */
export function listSessions(root = SESSIONS_ROOT, { limit = 20 } = {}) {
  if (!fs.existsSync(root)) throw new Error(`找不到会话目录：${root}（DSH 还没产生过会话？）`);
  const found = [];
  for (const projectDir of fs.readdirSync(root)) {
    const projectPath = path.join(root, projectDir);
    if (!fs.statSync(projectPath).isDirectory()) continue;
    for (const sessionDir of fs.readdirSync(projectPath)) {
      const file = path.join(projectPath, sessionDir, SESSION_FILE);
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      found.push({
        id: sessionDir.replace(/^session-/, ''),
        // 目录名把路径里的 / 转义成了 -，无法还原（dsh-plugin → plugin）。
        // 真正的 cwd 在会话第一条 session 事件里，读一次就准确了。
        project: readCwd(file) ?? projectDir.replace(/^--/, '').replace(/--$/, ''),
        file,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  }
  found.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return found.slice(0, limit);
}

/** 从会话文件里读第一条 session 事件上的 cwd（只读文件开头，不解整份）。 */
export function readCwd(file) {
  try {
    const buffer = fs.readFileSync(file);
    const text = file.endsWith('.zstd') ? decompressZstd(buffer) : buffer.toString('utf8');
    for (const line of text.split('\n').slice(0, 5)) {
      if (line.trim() === '') continue;
      try {
        const event = JSON.parse(line);
        if (typeof event.cwd === 'string') return event.cwd;
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 按 id 前缀 / 路径 / 「最新」定位一个会话文件。 */
export function resolveSession(target, root = SESSIONS_ROOT) {
  if (target !== undefined && target !== null && target !== '' && target !== 'latest') {
    if (fs.existsSync(target)) return { id: path.basename(path.dirname(target)).replace(/^session-/, ''), file: target };
    const all = listSessions(root, { limit: 1000 });
    const hits = all.filter((item) => item.id.startsWith(String(target)));
    if (hits.length === 0) throw new Error(`找不到会话 ${target}（在 ${root} 里按 id 前缀找）`);
    if (hits.length > 1) throw new Error(`会话 id 前缀不唯一（${hits.length} 个）：${hits.map((h) => h.id.slice(0, 8)).join('、')}`);
    return hits[0];
  }
  const all = listSessions(root, { limit: 1 });
  if (all.length === 0) throw new Error(`${root} 下没有任何会话`);
  return all[0];
}

/** 读会话事件（自动解 zstd，也接受已经解压的 .jsonl）。 */
export function readEvents(file) {
  const buffer = fs.readFileSync(file);
  const text = file.endsWith('.zstd') ? decompressZstd(buffer) : buffer.toString('utf8');
  const events = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 单行坏掉不该让整份战报失败：跳过并计数
      events.push({ type: 'unparsable' });
    }
  }
  return events;
}

/**
 * 找到「当前这个会话」的文件。
 *
 * 顺序：先按 cwd 匹配（会话自带的 cwd 字段最准），没有匹配就回退到最近活动的会话。
 * 放在 src/ 而不是插件入口里，是为了能在没有 @deepseek-ai/* 依赖的情况下离线测试。
 */
export function locateSession(cwd, { root } = {}) {
  const sessions = listSessions(root ?? SESSIONS_ROOT, { limit: 200 });
  if (sessions.length === 0) throw new Error(`在会话目录里没找到任何会话（cwd=${cwd}）`);
  const sameProject = sessions.filter((item) => item.project === cwd);
  return (sameProject.length > 0 ? sameProject : sessions)[0];
}
