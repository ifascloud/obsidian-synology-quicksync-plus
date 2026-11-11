# 更新记录

## 1.3.7

- 示例值与占位符统一改为 `my-nas` / `your-name`，仓库与构建产物中不含任何真实账号、地址或 QuickConnect ID
- 首次公开版本即此标签（仓库历史已整理为单一提交）

## 1.3.6 — 中文化

- 设置面板、命令、状态栏、通知、错误提示全部改为中文
- 默认忽略规则补上 `.trash/**`、`.obsidian/workspace.json`、`.obsidian/workspace-mobile.json`，避免回收站里的文件被当成新文件上传、避免两端工作区布局互相覆盖
- `tsconfig` 打开 `skipLibCheck`，`npm run typecheck` 在干净环境下可通过
- `manifest.json` 描述、作者信息、仓库简介改为中文

## 1.3.5 — 修复分支首个版本（id `synology-quicksync-plus`）

### 修复

- **冲突副本无限增殖。** 冲突处理从不写入基线，下一轮会再次判定同一处冲突，于是产生"副本的副本"。实测：14 篇笔记的库在 5 分钟间隔下 12 轮变成 1204 个 Markdown 文件，其中 1190 个是 `(conflict-syno-*)` 副本。现在冲突后会为原路径记录**双方实测**的 mtime 与大小。
- **首次同步被当成冲突。** 没有索引基线时，mtime 相差 2 秒以上就判"并发修改"，整库生成副本。现在首次同步按 mtime 较新一方胜出，不产生冲突副本。
- **下载后写入错误的本地 mtime。** 把 NAS 的 mtime 塞进 `localMtime`，而磁盘上文件带的是写入时刻，导致每次同步都判定"本地已改"。现在本地时间来自 `stat()`，远端时间在传输阶段结束后重新列目录回填。
- `tsc --noEmit` 因 `inlineSources` 缺少 `sourceMap` 报 TS5051，已修。

### 新增

- `VaultAdapter.stat()` 与传输后的远端刷新（`refreshRemote`），用于记录准确基线。
- 回归测试 `tests/sync-loop.test.ts`：首轮零副本、冲突只产生一份后收敛、双向删除、稳态零重复上传。
