# Changelog

## 0.1.0 — 首个版本

- `dsh-receipt`：把一次 DSH 会话变成一张可发布的战报（文本 + SVG 卡片 + 可选 PNG）
- 数字全部取自会话日志：时长、轮次、步数、工具调用（按工具分组）、涉及文件、
  tokens（输入/输出/缓存读分开算）、上下文压缩次数与被裁 token
- **默认脱敏**：项目名只留最后一段、文件只留 basename、会话 id 只显示前 8 位；
  要完整路径得显式加 `--show-paths`
- **不内置价目表**：只有你给了 `--price-in/--price-out/--price-cache` 才估算成本
- 零依赖（只需要 Node ≥ 22 的 `zlib`），只读，不写会话文件

### 实现里两个必须记下来的坑

1. **DSH 会话是多帧 zstd**：追加写出来的文件由很多个 zstd 帧拼成，
   而 Node 的 `zstdDecompressSync` / `createZstdDecompress` **只解第一帧且不报错**
   （实测 3.7MB 的会话只读出 1 个事件，流式接口直接 "Unknown frame descriptor"）。
   0.1.0 按帧魔数切分逐帧解，3,800 个事件全部读到。
2. **卡片布局要有页脚预算**：第一版行数一多就把工具列表压在页脚上，现在按剩余高度决定画几行。

### 修复

- 管道下游提前关闭（`| head` / `| tail`）时的 `EPIPE` 崩溃：现在安静退出。
