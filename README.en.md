# Synology QuickSync Plus

<p align="center">
  <strong>Bidirectional incremental Obsidian vault sync with Synology NAS via QuickConnect & File Station API (Desktop & Mobile)</strong>
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center">
  <a href="https://github.com/ifascloud/obsidian-synology-quicksync-plus/releases/latest">Releases</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/ifascloud/obsidian-synology-quicksync-plus/issues">Issues</a>
</p>

> ⭐ **If this plugin or the DSM protocol/sync fixes in this repository helped you, please consider giving it a Star!**  
> Your star helps others discover the fix and encourages ongoing maintenance across newer DSM and Obsidian releases.

---

## Overview

**Synology QuickSync Plus** is a bidirectional, incremental sync plugin for Obsidian and Synology NAS:

- **No Public IP / No Port Forwarding / No VPN Required**: Uses Synology **QuickConnect** for automatic endpoint discovery (prefers direct LAN `https://...:5001` at home, and seamlessly relays via QuickConnect when away or on cellular networks).
- **Cross-Platform**: Works on both Desktop (Windows, macOS, Linux) and Mobile (iOS, Android) (`isDesktopOnly: false`).
- **3-Way Incremental Diff**: Tracks sync baselines locally in `syncIndex`, transferring only changed or new files with zero redundant uploads/downloads at steady state.
- **Chinese UI**: Settings tab, commands, status bar indicators, and notices are localized in Simplified Chinese.

This repository (`synology-quicksync-plus`) is a maintained bug-fix fork of [fangjing2021/obsidian-synology-sync](https://github.com/fangjing2021/obsidian-synology-sync) (`synology-quicksync`, MIT License).

---

## What Was Fixed (vs. Upstream 1.3.4)

Upstream v1.3.4 suffered from **exponential conflict-copy amplification** and **Synology DSM File Station protocol bugs**. Releases v1.3.5–v1.3.8 fix these root causes and back them with automated tests:

| Issue | Upstream Behavior | Fix in Synology QuickSync Plus |
|---|---|---|
| **First-sync false conflicts** | Treated any >2s `mtime` delta with no baseline as a concurrent edit, generating conflict copies across the whole vault | Without a baseline, newer `mtime` wins cleanly — **zero conflict copies on initial sync** |
| **Infinite conflict-copy loop** | Never recorded index baselines after conflict handling, producing copies of copies every interval (14 notes grew to 1,204 files in 12 runs) | Records **measured local & remote `mtime`/size** after conflict resolution so subsequent runs converge cleanly |
| **Wrong `localMtime` after download** | Wrote remote `mtime` into `localMtime` while disk file had write time, triggering re-uploads every run | Reads actual disk metadata via `stat()` and refreshes remote metadata via `refreshRemote` after transfers |
| **DSM `List` `additional` parameter bug** | Sent `additional=time,size,md5` instead of a JSON array, causing DSM to return `mtime=0` and `size=0` so remote edits were never pulled (fixed in v1.3.8) | Sends URL-encoded JSON array `["time","size"]` per DSM File Station spec |
| **DSM `Upload` `mtime` unit bug** | Sent seconds instead of milliseconds; DSM divided by 1000, turning NAS file timestamps into `1970-01-21` (fixed in v1.3.8) | Always sends **millisecond** timestamps |
| **Smooth legacy baseline migration** | Existing `syncIndex` entries had `remoteMtime=0, remoteSize=0` | v1.3.8 compares `remote.size !== last.size` for legacy baselines and backfills real metadata without mass re-downloads or conflict storms, while pruning stale keys |
| **LAN protocol priority** | Probed plaintext HTTP before HTTPS on LAN | Prefers `https://...:5001` on LAN first, falling back to `http://...:5000` only if HTTPS is unreachable |
| **TypeScript & real tests** | `tsc --noEmit` failed with TS5051; no test suite existed in repo | Fixed `tsconfig.json` and added real `vitest` regression suites (`tests/sync-loop.test.ts`, `tests/protocol.test.ts`) |

---

## Installation

> ⚠️ **Back up your vault before running your first sync.**  
> ⚠️ Never run multiple sync tools (Synology Drive Client, Syncthing, iCloud, and this plugin) on the same vault directory at the same time.

### Option 1: BRAT (Recommended for Desktop & Mobile)

1. Install and enable **BRAT** (Beta Reviewers Auto-updater Tool) from Obsidian Community Plugins.
2. Go to **Settings → BRAT → Add Beta plugin**.
3. Enter `ifascloud/obsidian-synology-quicksync-plus`.
4. Enable **Synology QuickSync Plus** under **Settings → Community plugins**.

### Option 2: Manual Installation

1. Download `main.js` and `manifest.json` from the [latest Release](https://github.com/ifascloud/obsidian-synology-quicksync-plus/releases/latest).
2. Place both files into `<YourVault>/.obsidian/plugins/synology-quicksync-plus/`.
3. Open **Obsidian → Settings → Community plugins → Reload**, then enable **Synology QuickSync Plus**.

### Option 3: Official Community Plugins Directory

- The repository structure and metadata are prepared for submission to `obsidianmd/obsidian-releases`. Until review is completed, please use **BRAT** or **Manual Installation**.

---

## Configuration

Open **Obsidian → Settings → Synology QuickSync Plus** (the UI labels are in Simplified Chinese):

| Setting (UI Label) | Description & Recommendation |
|---|---|
| **QuickConnect ID** | Your Synology QuickConnect ID (e.g., `my-nas`; full QuickConnect URLs are also parsed automatically). Enables syncing from outside your LAN / mobile data. |
| **LAN Address** (`局域网地址（可选）`) | Strongly recommended to include the full HTTPS scheme, e.g., `https://192.168.1.100:5001`. Avoid `http://...:5000` so credentials are not sent in plaintext over LAN. |
| **DSM Account** (`DSM 账号`) | Create a **non-admin** DSM user with read/write permissions restricted solely to the target vault folder. |
| **DSM Password** (`DSM 密码`) | Stored locally in `.obsidian/plugins/synology-quicksync-plus/data.json` (`.obsidian/` is excluded from sync and never uploaded to the NAS). |
| **Remote Path** (`远端目录`) | **Must be set to a full folder path**, e.g., `/homes/your-name/Obsidian/MyVault`. Do **not** leave the default `/homes`, which would list all user home directories. |
| **Test Connection** (`测试连接`) | Verify NAS reachability and authentication before running your first sync. |
| **Auto-sync on startup** (`启动时自动同步`) | Automatically runs one sync pass when Obsidian finishes loading. |
| **Sync interval** (`定时同步间隔`) | Off / 5 / 15 / 30 minutes. For large vaults (thousands of notes), 15+ minutes is recommended. |
| **Ignore patterns** (`忽略规则`) | One glob per line (supports `*.tmp`, `dir/**`, etc.). Defaults include `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.git/**`, `*.tmp`, `.trash/**`, `.obsidian/workspace.json`, and `.obsidian/workspace-mobile.json`. |

---

## Usage

- **Ribbon Icon**: Click the refresh icon (`群晖同步：立即同步`) to trigger a manual sync.
- **Command Palette** (`Ctrl/Cmd + P`):
  - `Synology QuickSync Plus: 立即同步` (Sync Now)
  - `Synology QuickSync Plus: 测试连接` (Test Connection)
- **Status Bar**:
  - `✓ 群晖：就绪` (Idle / shows summary counts after sync)
  - `⏳ 群晖：同步中…` (Syncing)
  - `! 群晖：部分失败` (Partial errors — failed items retry on next pass)
  - `✗ 群晖：出错` (Error)

---

## Sync Behavior, Conflicts & Limitations

1. **Initial Sync**:
   - Local-only files are uploaded; remote-only files are downloaded.
   - Files present on both sides with different timestamps resolve in favor of the newer `mtime` without generating conflict copies.
2. **Concurrent Conflicts**:
   - If both local and remote changed since the last sync baseline, the local file is kept intact and the remote version is saved as:
     `<name> (conflict-syno-YYYY-MM-DDTHH-mm-ss).md`
   - Merge manually and remove the conflict copy when done.
3. **Deletion Semantics**:
   - **Remote delete**: Removing a file locally calls `SYNO.FileStation.Delete` on the NAS, which is **permanent** unless `#recycle` is enabled on the Synology shared folder.
   - **Local delete**: Removing a file on the NAS moves the local copy to Obsidian's trash (`.trash/`).
4. **Hidden Dot-folders**:
   - Obsidian's `vault.getFiles()` skips dot-prefixed folders (such as `.obsidian/` or `.claudian/`) by design.
5. **HTTPS & Certificates**:
   - If your LAN NAS uses a self-signed certificate, trust the CA on your devices or connect via QuickConnect HTTPS relay.

---

## Development & Testing

```bash
git clone https://github.com/ifascloud/obsidian-synology-quicksync-plus.git
cd obsidian-synology-quicksync-plus
npm ci
npm run typecheck   # TypeScript check
npm test            # Vitest regression suite (sync convergence + DSM protocol tests)
npm run build       # Bundle main.js
```

Test coverage includes:
- `tests/sync-loop.test.ts`: Zero conflict copies on first sync, conflict convergence without loops, bidirectional deletion, and steady-state zero re-transfers.
- `tests/protocol.test.ts`: DSM `List` `additional=["time","size"]` encoding, `Upload` millisecond `mtime`, LAN HTTPS-first probing, and v1.3.8 legacy baseline migration.

---

## Credits & Support

- Upstream project: [fangjing2021/obsidian-synology-sync](https://github.com/fangjing2021/obsidian-synology-sync)
- Maintained by: [ifascloud](https://github.com/ifascloud)

If you use this plugin or reuse the DSM protocol fixes in your own workflow:

**👉 Please give the repository a [Star ⭐](https://github.com/ifascloud/obsidian-synology-quicksync-plus) on GitHub!**  
Issues and feedback with your DSM version are always welcome.

---

## License

Licensed under the **MIT License**. Original copyright belongs to [fangjing2021](https://github.com/fangjing2021); modifications in this fork are likewise released under MIT.
