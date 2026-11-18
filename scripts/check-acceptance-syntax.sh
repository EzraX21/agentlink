#!/usr/bin/env bash
# 所有验收脚本必须是**纯 JS**：`node --check` 能过。
#
# 为什么单独一个检查：我三次把 TS 语法（`as`、`<T>`、泛型标注）写进 .mjs，
# 每次都是跑到那一条才炸，而且报错位置离真正的笔误很远。
# 这个检查 0.5 秒跑完所有脚本，把它放进 verify.sh 的第一步。
set -u
fail=0
for f in scripts/acceptance/*.mjs; do
  if ! node --check "$f" >/dev/null 2>&1; then
    echo "语法错误（验收脚本必须是纯 JS）: $f"
    node --check "$f" 2>&1 | head -4
    fail=1
  fi
done
if [ "$fail" -eq 0 ]; then
  echo "验收脚本语法检查通过（$(ls scripts/acceptance/*.mjs | wc -l) 个文件）"
fi
exit $fail
