# docs/ 里的图怎么来的

这些是**真实输出**，不是画的示意图。重新生成：

```sh
# 单会话卡片
node bin/receipt.mjs --list                     # 挑一个会话 id（第一列）
node bin/receipt.mjs <id> --svg docs/session-card.svg --png docs/session-card.png

# 周期卡片（最近 7 天、只看某个项目）
node bin/receipt.mjs --since 7d --project dsh-plugin \
  --svg docs/period-card.svg --png docs/period-card.png
```

PNG 是用本机 Chrome 把 SVG 转出来的（`--png` 内部做的事）。
数字会随你的会话变化，图里的数值只是某一次运行的快照。
