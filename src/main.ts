import { Plugin, Notice, requestUrl, RequestUrlParam, TFile, normalizePath } from 'obsidian';
import { SynoSyncSettings, DEFAULT_SETTINGS, LocalFileItem, RemoteFileItem, SyncIndex } from './types';
import { SynologySyncSettingTab } from './settings/settings-tab';
import { QuickConnectResolver } from './syno/qc-resolver';
import { SynologyApiClient, HttpRequester } from './syno/api-client';
import { computeDiff } from './sync/diff-engine';
import { SyncManager, VaultAdapter, SyncHooks } from './sync/sync-manager';

/** 单次 HTTP 请求上限：手机网络切换/中继断流时避免整个同步无限期挂住。 */
const REQUEST_TIMEOUT_MS = 120_000;

export default class SynologySyncPlugin extends Plugin {
  settings: SynoSyncSettings = DEFAULT_SETTINGS;
  syncIndex: SyncIndex = {};
  private statusBarEl!: HTMLElement;
  private isSyncing: boolean = false;
  private syncIntervalId: number | null = null;
  private activeClient: SynologyApiClient | null = null;

  async onload() {
    await this.loadSettings();

    // 1. Register Setting Tab
    this.addSettingTab(new SynologySyncSettingTab(this.app, this));

    // 2. Register Status Bar Item
    this.statusBarEl = this.addStatusBarItem();
    this.setStatusBar('idle');

    // 3. Register Ribbon Icon
    this.addRibbonIcon('refresh-cw', '群晖同步：立即同步', async () => {
      await this.runSync();
    });

    // 4. Register Sync Command
    this.addCommand({
      id: 'sync-now',
      name: '立即同步',
      callback: async () => {
        await this.runSync();
      },
    });

    // 5. Register Test Connection Command
    this.addCommand({
      id: 'test-connection',
      name: '测试连接',
      callback: async () => {
        try {
          new Notice('正在测试群晖 NAS 连接…');
          await this.testConnection();
          new Notice('✓ 已成功连接群晖 NAS');
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          new Notice(`✗ 连接失败：${msg}`);
        }
      },
    });

    // 6. Auto sync on startup using official onLayoutReady hook
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoSyncOnStartup) {
        this.runSync().catch(console.error);
      }
    });

    // 7. Setup periodic interval sync
    this.setupSyncInterval();
  }

  onunload() {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (this.activeClient) {
      this.activeClient.logout().catch(console.error);
      this.activeClient = null;
    }
    this.setStatusBar('offline');
  }

  async loadSettings() {
    const data = await this.loadData();
    if (data) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || data);
      this.syncIndex = data.syncIndex || {};
    } else {
      this.settings = Object.assign({}, DEFAULT_SETTINGS);
      this.syncIndex = {};
    }
  }

  async saveSettings() {
    await this.saveData({
      settings: this.settings,
      syncIndex: this.syncIndex,
    });
  }

  resetActiveSession() {
    if (this.activeClient) {
      this.activeClient.logout().catch(console.error);
      this.activeClient = null;
    }
  }

  setupSyncInterval() {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (this.settings.syncIntervalMinutes > 0) {
      this.syncIntervalId = window.setInterval(() => {
        this.runSync().catch(console.error);
      }, this.settings.syncIntervalMinutes * 60 * 1000);
    }
  }

  private setStatusBar(state: 'idle' | 'syncing' | 'error' | 'offline' | 'partial-error', text?: string) {
    if (!this.statusBarEl) return;
    if (state === 'idle') {
      this.statusBarEl.setText(text ? `✓ 群晖：${text}` : '✓ 群晖：就绪');
    } else if (state === 'syncing') {
      this.statusBarEl.setText(text ? `⏳ 群晖：${text}` : '⏳ 群晖：同步中…');
    } else if (state === 'error') {
      this.statusBarEl.setText('✗ 群晖：出错');
    } else if (state === 'partial-error') {
      this.statusBarEl.setText('! 群晖：部分失败');
    } else {
      this.statusBarEl.setText('');
    }
  }

  private parseJsonResponse(res: { text?: string; json?: any }): any {
    if (typeof res.text === 'string' && res.text.trim()) {
      try {
        return JSON.parse(res.text.trim());
      } catch {
        // Response is binary or plain text (e.g. Markdown note), not JSON
        return undefined;
      }
    }
    try {
      return res.json;
    } catch {
      return undefined;
    }
  }

  private createResolver(): QuickConnectResolver {
    const pingFn = async (url: string) => {
      let timeoutHandle: number | null = null;
      const timeoutPromise = new Promise<boolean>((resolve) => {
        timeoutHandle = window.setTimeout(() => resolve(false), 2000);
      });

      const pingPromise = (async () => {
        try {
          const res = await requestUrl({
            url: `${url}/webapi/entry.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth`,
            method: 'GET',
            throw: false,
          });
          const data = this.parseJsonResponse(res);
          if (data && data.success === true) return true;

          if (res.status === 200 || res.status === 404 || res.status === 302) {
            const fallback = await requestUrl({
              url: `${url}/webapi/auth.cgi?api=SYNO.API.Auth&version=1&method=query`,
              method: 'GET',
              throw: false,
            });
            const fbData = this.parseJsonResponse(fallback);
            return Boolean(fbData && fbData.success === true);
          }
          return false;
        } catch {
          return false;
        } finally {
          if (timeoutHandle !== null) {
            window.clearTimeout(timeoutHandle);
          }
        }
      })();
      return Promise.race([pingPromise, timeoutPromise]);
    };

    const qcFetcher = async (url: string, body: any) => {
      try {
        const res = await requestUrl({
          url,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          throw: false,
        });
        return this.parseJsonResponse(res);
      } catch {
        return null;
      }
    };

    return new QuickConnectResolver(pingFn, qcFetcher);
  }

  private getHttpRequester(): HttpRequester {
    return async (options) => {
      const param: RequestUrlParam = {
        url: options.url,
        method: options.method || 'GET',
        headers: options.headers,
        body: options.body as any,
        throw: false,
      };

      let timer: number | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒无响应），该项已跳过，下次同步会重试`)),
          REQUEST_TIMEOUT_MS
        );
      });

      try {
        const res = await Promise.race([requestUrl(param), timeoutPromise]);
        const parsedJson = this.parseJsonResponse(res);
        return {
          status: res.status,
          headers: res.headers,
          json: parsedJson,
          text: res.text,
          arrayBuffer: res.arrayBuffer,
        };
      } finally {
        if (timer !== null) {
          window.clearTimeout(timer);
        }
      }
    };
  }

  private getVaultAdapter(): VaultAdapter {
    return {
      readBinary: async (path: string) => {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (file instanceof TFile) {
          return await this.app.vault.readBinary(file);
        }
        throw new Error(`File not found: ${path}`);
      },
      writeBinaryAtomic: async (path: string, content: ArrayBuffer) => {
        const norm = normalizePath(path);
        const slashIdx = norm.lastIndexOf('/');
        if (slashIdx !== -1) {
          const parentDir = norm.substring(0, slashIdx);
          const parts = parentDir.split('/');
          let current = '';
          for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(current)) {
              try {
                await this.app.vault.createFolder(current);
              } catch {
                // Ignore if already created
              }
            }
          }
        }
        const file = this.app.vault.getAbstractFileByPath(norm);
        if (file instanceof TFile) {
          await this.app.vault.modifyBinary(file, content);
        } else {
          await this.app.vault.createBinary(norm, content);
        }
      },
      deleteFile: async (path: string) => {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (file instanceof TFile) {
          // 移动到回收站，尊重用户在 Obsidian 设置中的删除偏好
          await this.app.fileManager.trashFile(file);
        }
      },
      stat: async (path: string) => {
        const st = await this.app.vault.adapter.stat(normalizePath(path));
        if (!st) throw new Error(`File not found: ${path}`);
        return { mtime: st.mtime, size: st.size };
      },
    };
  }

  private async getLocalFiles(): Promise<LocalFileItem[]> {
    const files = this.app.vault.getFiles();
    return files.map((f) => ({
      path: f.path,
      mtime: f.stat.mtime,
      size: f.stat.size,
    }));
  }

  private async getAuthenticatedClient(): Promise<SynologyApiClient> {
    if (this.activeClient && this.activeClient.getSid()) {
      return this.activeClient;
    }

    const http = this.getHttpRequester();
    const resolver = this.createResolver();

    const baseUrl = await resolver.resolveBaseUrl(this.settings.quickConnectId, this.settings.lanAddress);
    const client = new SynologyApiClient(baseUrl, http);
    await client.login(this.settings.account, this.settings.password);

    this.activeClient = client;
    return client;
  }

  async testConnection(): Promise<void> {
    if (!this.settings.quickConnectId && !this.settings.lanAddress) {
      throw new Error('请先在插件设置中填写 QuickConnect ID 或局域网地址。');
    }
    if (!this.settings.account || !this.settings.password) {
      throw new Error('请先在插件设置中填写群晖 DSM 账号和密码。');
    }

    const http = this.getHttpRequester();
    const resolver = this.createResolver();

    const baseUrl = await resolver.resolveBaseUrl(this.settings.quickConnectId, this.settings.lanAddress);
    const client = new SynologyApiClient(baseUrl, http);
    await client.login(this.settings.account, this.settings.password);
    try {
      // login successful
    } finally {
      await client.logout().catch(console.error);
    }
  }

  async runSync(): Promise<void> {
    if (this.isSyncing) {
      new Notice('同步正在进行中');
      return;
    }

    if (!this.settings.quickConnectId && !this.settings.lanAddress) {
      new Notice('请先在设置中填写 QuickConnect ID 或局域网地址。');
      return;
    }
    if (!this.settings.account || !this.settings.password) {
      new Notice('请先在设置中填写群晖 DSM 账号和密码。');
      return;
    }
    if (!this.settings.remotePath) {
      new Notice('请先在设置中配置群晖远端目录路径。');
      return;
    }

    this.isSyncing = true;
    this.setStatusBar('syncing', '准备中…');

    try {
      let client = await this.getAuthenticatedClient();

      // 首次清理远端目录结构前，也要先刷新一次索引基线
      let remoteFiles: RemoteFileItem[];
      try {
        remoteFiles = await client.listFiles(this.settings.remotePath);
      } catch (err: unknown) {
        // 若会话超时失效 (DSM error 105, 106, 107, 119)，清除缓存并重新登录一次
        const errMsg = err instanceof Error ? err.message : String(err);
        const isSessionExpired =
          errMsg.includes('105') || errMsg.includes('106') || errMsg.includes('107') || errMsg.includes('119');
        if (isSessionExpired) {
          this.activeClient = null;
          client = await this.getAuthenticatedClient();
          remoteFiles = await client.listFiles(this.settings.remotePath);
        } else {
          throw err;
        }
      }

      // 1. Fetch local files
      const localFiles = await this.getLocalFiles();

      // 2. Compute 3-way diff (dynamically include vault configDir to protect settings)
      const effectiveIgnore = [
        ...(this.settings.ignorePatterns || []),
        `${this.app.vault.configDir}/**`,
      ];
      const diff = computeDiff(localFiles, remoteFiles, effectiveIgnore, this.syncIndex);

      const totalWork =
        diff.uploads.length +
        diff.downloads.length +
        diff.conflicts.length +
        diff.deletesRemote.length;
      if (totalWork > 0) {
        this.setStatusBar('syncing', `0/${totalWork}…`);
        new Notice(`开始同步：待处理 ${totalWork} 项`, 4000);
      }

      // 3. Execute sync
      const activeClient = client;
      const refreshRemote = async (): Promise<Map<string, RemoteFileItem>> => {
        const files = await activeClient.listFiles(this.settings.remotePath);
        const map = new Map<string, RemoteFileItem>();
        for (const f of files) {
          if (!f.isdir) map.set(f.path, f);
        }
        return map;
      };

      const hooks: SyncHooks = {
        onProgress: (done, total, phase) => {
          if (phase === '完成') {
            this.setStatusBar('syncing', '收尾中…');
            return;
          }
          this.setStatusBar('syncing', `${phase} ${done}/${total}`);
        },
        // 中途落盘：手机被系统挂起、App 被切后台或网络中断后，不必从零重来
        persist: async (index) => {
          this.syncIndex = index;
          await this.saveSettings();
        },
        relogin: async () => {
          this.activeClient = null;
          await this.getAuthenticatedClient();
        },
      };

      const manager = new SyncManager(
        client,
        this.getVaultAdapter(),
        this.settings.remotePath,
        this.syncIndex,
        refreshRemote,
        hooks
      );
      const report = await manager.executeSync(diff);

      // 4. Update and persist syncIndex (prune stale entries absent from both local and remote)
      if (report.updatedIndex) {
        const activePaths = new Set<string>();
        for (const f of localFiles) activePaths.add(f.path);
        for (const f of remoteFiles) {
          if (!f.isdir) activePaths.add(f.path);
        }
        for (const item of diff.uploads) activePaths.add(item.path);
        for (const item of diff.downloads) activePaths.add(item.path);
        for (const key of Object.keys(report.updatedIndex)) {
          if (!activePaths.has(key)) {
            delete report.updatedIndex[key];
          }
        }
        this.syncIndex = report.updatedIndex;
        await this.saveSettings();
      }

      if (report.errors.length > 0) {
        this.setStatusBar('partial-error');
        const firstErr = report.errors[0] ? `（${report.errors[0].error}）` : '';
        new Notice(
          `同步完成但有错误：上传 ${report.uploadedCount} 下载 ${report.downloadedCount} 冲突 ${report.conflictCount} 删除 ${report.deletedRemoteCount + report.deletedLocalCount}，失败 ${report.errors.length} 项${firstErr}`,
          10000
        );
        console.warn('[群晖同步] 同步完成但有错误：', report.errors);
      } else {
        this.setStatusBar('idle', '已完成');
        new Notice(
          `同步完成：上传 ${report.uploadedCount} 下载 ${report.downloadedCount} 冲突 ${report.conflictCount} 删除 ${report.deletedRemoteCount + report.deletedLocalCount}`
        );
      }
    } catch (e: unknown) {
      this.setStatusBar('error');
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`同步失败：${msg}`, 10000);
      console.error('[群晖同步]', e);
      // 若是网络不可达或关键错误，重置缓存以便下次重新探活
      this.activeClient = null;
    } finally {
      this.isSyncing = false;
    }
  }
}