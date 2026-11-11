# Synology QuickSync Plus

Obsidian 插件：通过 **QuickConnect** 把库同步到群晖 NAS，走 File Station API，手机和电脑都能用，不需要公网 IP、不需要端口映射。

这是 [fangjing2021/obsidian-synology-sync](https://github.com/fangjing2021/obsidian-synology-sync)（插件 id `synology-quicksync`，MIT）的修复分支。原版的双向同步在"首次同步 + 定时同步"组合下会产生无限自我复制的冲突副本（见下），本分支修掉了这个问题。

## 修了什么

原版 1.3.4 的三个缺陷会让冲突副本指数增长（实测：5 分钟一轮，12 轮把 14 篇笔记的库撑成 1204 个文件，其中 1190 个是 `(conflict-syno-*)` 副本）。

| 缺陷 | 原版行为 | 本分支 |
|---|---|---|
| 首次同步判冲突 | 没有索引基线时，仅因 mtime 相差 >2 秒就判"并发修改"，整库生成副本 | 没有基线就没有"历史分歧"，一律按 mtime 新的一方胜出，**不产生冲突副本** |
| 冲突副本不写索引 | 写完副本不更新索引，下一轮再次判冲突 → 副本的副本 | 冲突处理后为原路径记录**双方实测状态**（本地 mtime/大小 + 远端 mtime/大小），下一轮判定为未变更 |
| 索引写入错误的 mtime | 下载后把远端 mtime 塞进 `localMtime`，而磁盘上是写入时刻 → 每轮都判"本地已改" | 每次动作后 `stat()` 真实文件，远端的 mtime 由同步结束后重新列目录回填（`refreshRemote`） |

另外：`tsconfig.json` 的 `inlineSources` 缺 `sourceMap` 导致 `tsc --noEmit` 直接报 TS5051，已修；原版 README 声称的 `tests 73/73 passing` 在仓库里并不存在测试目录，本分支补了真实的回归测试。

## 测试

```bash
npm ci
npm test        # vitest：首轮不产生副本、冲突只产生一份、删除双向传播、稳态零重复上传
npm run build   # 产出 main.js
```

回归用例在 `tests/sync-loop.test.ts`，用内存假库 + 假 NAS 跑多轮同步周期，直接断言"第 3 轮之后不再出现新的冲突副本"。

## 安装

**方式一：手动（立即可用）**

1. 下载 release 里的 `main.js`、`manifest.json`
2. 放到 `<你的库>/.obsidian/plugins/synology-quicksync-plus/`
3. Obsidian → 设置 → 第三方插件 → 重新加载 → 启用 "Synology QuickSync Plus"

**方式二：BRAT**

BRAT → Add Beta plugin → 填 `ifascloud/obsidian-synology-quicksync-plus`

**方式三：社区插件目录**

已向 `obsidianmd/obsidian-releases` 提交收录申请，通过后可直接在 Obsidian 里搜索安装（人工审核，需要等待）。

## 设置要点

| 项 | 建议 |
|---|---|
| QuickConnect ID | 填你自己的 QC ID（如 `my-nas`），走群晖中继，外网/4G 可用 |
| LAN 地址 | **写全协议** `https://192.168.x.x:5001`，不要用 `http://...:5000`：插件把密码放在请求里，HTTP 下会在局域网明文传输 |
| 账号 | 建一个只对目标共享目录有读写权限的普通账号，不要用管理员 |
| 远端路径 | **必须自己填**，例如 `/homes/<用户>/Obsidian/vault`；默认的 `/homes` 会去列所有用户的 home |
| 忽略规则 | 建议加入 `.obsidian/workspace.json`、`.obsidian/workspace-mobile.json`、`.trash/`、`*.tmp`（`.obsidian/` 本身已被强制忽略，插件设置不会同步） |

首次同步前先备份本地库。首次同步只做"各自独有文件的上传/下载"，不会清空任何一侧。

## 已知边界

- 远端删除走 `FileStation.Delete`，是**永久删除**（除非 NAS 共享文件夹开了回收站）；本地删除走 Obsidian 回收站，可恢复。
- 密码以明文保存在插件 `data.json` 里（与原版一致）。请使用 HTTPS 直连，或至少保证库目录本身不被同步到别处。
- 冲突策略：远端版本另存为 `<名> (conflict-syno-<时间戳>).md`，两份都保留，人工裁决。
- 同一目录不要同时跑两套同步工具（Drive Client / Syncthing / 本插件只能选一套）。

## 许可

MIT，原始版权归 [fangjing2021](https://github.com/fangjing2021)。本分支的修改同样以 MIT 发布。
