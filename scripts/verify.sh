#!/usr/bin/env bash
# 静态自检：语法 + 包元信息 + 离线单测。不需要 DSH 也不需要联网。
set -uo pipefail
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PKG_DIR"
fail=0
step() { printf '\n== %s ==\n' "$1"; }

step '1/3 JS 语法'
for file in bin/*.mjs src/*.mjs scripts/selftest.mjs; do
  if node --check "$file" 2>/dev/null; then echo "  ✓ $file"; else echo "  ✗ $file"; fail=1; fi
done

step '2/3 包元信息'
node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
let bad = 0;
const check = (label, ok) => { console.log(`  ${ok ? "✓" : "✗"} ${label}`); if (!ok) bad = 1; };
check("bin 指向存在的文件", typeof pkg.bin?.["dsh-receipt"] === "string" && fs.existsSync(pkg.bin["dsh-receipt"]));
check("零运行时依赖", (pkg.dependencies === undefined) || Object.keys(pkg.dependencies).length === 0);
check("engines.node >= 22", String(pkg.engines?.node ?? "").includes("22"));
check("repository 指向本仓库", String(pkg.repository?.url ?? "").includes("dsh-receipt"));
process.exit(bad);
' || fail=1

step '3/3 离线单测'
node scripts/selftest.mjs || fail=1

printf '\n'
[ "$fail" -eq 0 ] && echo "✅ 静态自检通过" || echo "❌ 静态自检失败"
exit "$fail"
