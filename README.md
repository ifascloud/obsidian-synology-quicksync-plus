# Synology QuickSync Plus

<p align="center">
  <strong>通过群晖 QuickConnect 与 File Station API 双向增量同步 Obsidian 知识库（桌面端 & 移动端通用）</strong>
</p>

<p align="center">
  <strong>简体中文</strong> | <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/ifascloud/obsidian-synology-quicksync-plus/releases/latest">Releases</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="https://github.com/ifascloud/obsidian-synology-quicksync-plus/issues">问题反馈</a>
</p>

> ⭐ **如果这个插件或本仓库的协议/同步修复代码帮到了你，欢迎点右上角的 Star 支持一下！**  
> 你的每一个 Star 都是持续维护与适配新版 DSM / Obsidian 的动力。

---

## 这是什么

**Synology QuickSync Plus** 是一款面向群晖 NAS 用户的 Obsidian 双向增量同步插件：

- **免公网 IP / 免端口映射 / 免 VPN**：基于群晖 **QuickConnect** 自动发现链路（内网优先直连 `https://...:5001`，外网或手机流量自动走 QuickConnect 中继）。
- **全平台支持**：桌面端（Windows / macOS / Linux）与移动端（iOS / Android）均可使用（`isDesktopOnly: false`）。
- **增量同步与三向比对**：本地维护 `syncIndex` 基线，只传输新增或修改的文件，稳态同步零重复上传/下载。
- **全中文界面**：设置面板、命令面板、状态栏提示与通知均为简体中文。

本项目是 [fangjing2021/obsidian-synology-sync](https://github.com/fangjing2021/obsidian-synology-sync)（原插件 ID `synology-quicksync`，MIT 协议）的深度修复与增强分支（现插件 ID `synology-quicksync-plus`）。

---

## 相比原版修复了什么

原版 1.3.4 在实际使用中存在**冲突副本指数增殖**及**群晖 File Station 协议兼容性**问题，本分支已在 v1.3.5 ～ v1.3.8 逐一修复并补齐自动化测试：

| 问题类别 | 原版行为 | Synology QuickSync Plus 修复方案 |
|---|---|---|
| **首次同步误判冲突** | 无本地基线时仅因 `mtime` 相差 > 2 秒即判并发修改，整库生成冲突副本 | 无基线时一律以较新 `mtime` 一方胜出，**不产生冲突副本** |
| **冲突副本无限自我复制** | 写完 `(conflict-syno-*)` 副本后不更新索引，下一轮继续判冲突，5 分钟一轮很快涨到上千个副本 | 冲突处理后为原路径记录**双端实测元数据**，下一轮自动收敛为未变更 |
| **下载后 `localMtime` 失真** | 下载后把远端时间戳写入 `localMtime`，与磁盘实际写入时间不符，导致每轮误判“本地已改” | 每次读写后通过 `stat()` 读取真实本地时间，传输结束后重新列目录回填远端元数据 |
| **DSM `List` 接口 `additional` 格式错误** | 传 `additional=time,size,md5` 而非 JSON 数组，导致 DSM 返回 `mtime=0`、`size=0`，远端编辑永远无法增量拉取（v1.3.8 修复） | 改为标准 URL 编码 JSON 数组 `["time","size"]`，真实获取远端 `mtime` 与大小 |
| **DSM `Upload` 接口 `mtime` 单位错误** | 传秒级时间戳被 DSM 除以 1000，导致 NAS 文件修改时间变成 `1970-01-21`（v1.3.8 修复） | 统一换算并传递**毫秒级**时间戳 |
| **旧基线平滑升级** | 旧版索引里存在大量 `remoteMtime=0, remoteSize=0` 记录 | v1.3.8 自动按字节大小比对远端变更并在本轮回填真实时间戳，**升级不触发全库重下或冲突风暴**，并清理双端已消失的陈旧索引 |
| **内网探测协议顺序** | 局域网先试明文 HTTP | 改为优先探测 `https://...:5001`，不可达再回退 `http://...:5000` |
| **工程与测试** | `tsconfig` 报 TS5051；仓库缺少真实测试 | 修复类型检查，新增 `vitest` 回归套件（多轮同步收敛 + DSM 协议单测） |

---

## 安装方法

> ⚠️ **首次同步前请务必备份你的本地 Obsidian 知识库。**  
> ⚠️ 请勿对同一个知识库目录同时启用多套同步工具（如 Synology Drive Client、Syncthing、iCloud 与本插件混跑）。

### 方式一：通过 BRAT 安装（推荐，电脑与手机通用）

1. 在 Obsidian 社区插件市场安装并启用 **BRAT**（Beta Reviewers Auto-updater Tool）。
2. 打开 **设置 → BRAT → Add Beta plugin**。
3. 输入仓库地址：`ifascloud/obsidian-synology-quicksync-plus`。
4. 在 **设置 → 第三方插件** 中启用 **Synology QuickSync Plus**，后续可在 BRAT 中一键检查更新。

### 方式二：手动安装

1. 前往 [Releases 最新版本](https://github.com/ifascloud/obsidian-synology-quicksync-plus/releases/latest) 下载 `main.js` 和 `manifest.json`。
2. 在你的知识库目录下创建文件夹：`<你的库>/.obsidian/plugins/synology-quicksync-plus/`。
3. 将下载的两个文件放入该目录。
4. 打开 **Obsidian → 设置 → 第三方插件 → 重新加载**，启用 **Synology QuickSync Plus**。

### 方式三：官方社区插件市场

- 本插件已按 Obsidian 官方规范整理结构与多端兼容说明，待收录流程通过后可直接在社区插件市场搜索安装；在此之前请使用 **BRAT** 或 **手动安装**。

---

## 配置指南

打开 **Obsidian → 设置 → Synology QuickSync Plus**：

| 设置项 | 填写说明与建议 |
|---|---|
| **QuickConnect ID** | 填写群晖 QuickConnect ID（例如 `my-nas`；也兼容粘贴完整网址如 `https://my-nas.quickconnect.cn/`）。用于外网、咖啡馆 Wi-Fi 或手机 4G/5G 同步。 |
| **局域网地址（可选）** | 建议填写带协议的完整 HTTPS 地址，例如 `https://192.168.1.100:5001`。**不建议**使用 `http://...:5000`，避免登录密码在局域网内明文传输。 |
| **DSM 账号** | 强烈建议在群晖 DSM 中新建一个**非管理员**普通账号，仅赋予目标同步文件夹的读写权限。 |
| **DSM 密码** | 对应账号密码。密码保存在本机 `.obsidian/plugins/synology-quicksync-plus/data.json` 中（`.obsidian/` 目录本身不会被同步到 NAS）。 |
| **远端目录** | **必须修改为完整目录路径**，例如 `/homes/your-name/Obsidian/MyVault` 或 `/Syncthing/obsidian/MyVault`。**切勿保留默认的 `/homes`**，否则会扫描所有用户的根目录。 |
| **测试连接** | 填好以上信息后先点击 **测试连接**，确认网络可达且登录成功后再开始同步。 |
| **启动时自动同步** | 开启后，每次打开 Obsidian 界面就绪时自动执行一次同步。 |
| **定时同步间隔** | 支持 `关闭` / `每 5 分钟` / `每 15 分钟` / `每 30 分钟`。笔记数量较多（数千篇以上）时建议设为 `15 分钟` 以上。 |
| **忽略规则** | 每行一条通配符（支持 `*.tmp`、`目录/**` 等）。默认已包含 `.DS_Store`、`Thumbs.db`、`desktop.ini`、`.git/**`、`*.tmp`、`.trash/**`、`.obsidian/workspace.json`、`.obsidian/workspace-mobile.json`。 |

---

## 使用说明

- **侧边栏图标**：点击左侧功能区刷新图标（`群晖同步：立即同步`）即可手动触发一次双向同步。
- **命令面板**（`Ctrl/Cmd + P`）：
  - `Synology QuickSync Plus: 立即同步`
  - `Synology QuickSync Plus: 测试连接`
- **底部状态栏**：实时显示同步状态：
  - `✓ 群晖：就绪`（或显示最近一次同步的上传/下载/跳过统计）
  - `⏳ 群晖：同步中…`
  - `! 群晖：部分失败`（单轮个别文件失败，下轮会重试）
  - `✗ 群晖：出错`

---

## 同步规则、冲突与安全边界

1. **首次同步行为**：
   - 本地独有文件 → 上传到 NAS；
   - 远端独有文件 → 下载到本地；
   - 两端同名文件 → 取 `mtime` 较新的一方覆盖较旧一方，不产生冲突副本。
2. **双向并发冲突**：
   - 当同一文件自上次同步基线后**本地与远端均被修改**时，插件保留本地文件不变，将远端版本下载并另存为：
     `原文件名 (conflict-syno-YYYY-MM-DDTHH-mm-ss).md`
   - 你可以对照两份文件手动合并后删除副本。
3. **删除行为（重要）**：
   - **远端删除**：本地删除文件后，下轮同步会调用 `SYNO.FileStation.Delete` 删除 NAS 上的对应文件。**该操作是永久删除**（除非你在 DSM 控制面板中为对应共享文件夹启用了 `#recycle` 回收站）。
   - **本地删除**：远端删除文件后，本地会移入 Obsidian 回收站（`.trash/`，可在本地找回）。
4. **隐藏文件夹（点开头目录）**：
   - Obsidian 的 `vault.getFiles()` 默认忽略 `.obsidian/`、`.claudian/` 等以 `.` 开头的隐藏目录，这是 Obsidian API 的标准行为。
5. **证书与 HTTPS 提示**：
   - 若群晖使用自签名或局域网 IP 证书，确保手机/电脑系统信任该证书，或通过 QuickConnect 官方 HTTPS 中继连接；如遇到极端内网自签证书无法握手且确认网络可信，才考虑使用内网 HTTP（注意密码明文风险）。

---

## 本地开发与测试

```bash
git clone https://github.com/ifascloud/obsidian-synology-quicksync-plus.git
cd obsidian-synology-quicksync-plus
npm ci
npm run typecheck   # TypeScript 类型检查
npm test            # 运行 Vitest 回归测试（同步收敛 + DSM 协议单测）
npm run build       # 构建生成 main.js
```

回归测试包含：
- `tests/sync-loop.test.ts`：首次同步零副本、并发冲突收敛不再增殖、双向删除传播、稳态零重复传输。
- `tests/protocol.test.ts`：DSM `List` `additional=["time","size"]` 参数格式、`Upload` 毫秒级 `mtime`、LAN HTTPS 优先探测、v1.3.8 旧基线平滑迁移。

---

## 致谢与 Star 支持

- 原始项目：[fangjing2021/obsidian-synology-sync](https://github.com/fangjing2021/obsidian-synology-sync)
- 当前维护与协议修复：[ifascloud](https://github.com/ifascloud)

如果这个项目帮你省去了折腾公网 IP / 端口映射的麻烦，或者修好了你的 Obsidian 群晖同步问题——

**👉 请顺手点击仓库右上角的 [Star ⭐](https://github.com/ifascloud/obsidian-synology-quicksync-plus) 支持一下！**  
也欢迎提 Issue 反馈你的 DSM 版本与使用场景。

---

## 开源许可

本项目以 **MIT License** 开源，原始版权归 [fangjing2021](https://github.com/fangjing2021)，本分支新增及修改代码同样遵循 MIT 协议发布。
