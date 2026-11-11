import { DiffResult, RemoteFileItem, SyncIndex } from '../types';
import { SynologyApiClient } from '../syno/api-client';
import { recordBaseline } from './index-tracker';

export interface VaultStat {
  mtime: number;
  size: number;
}

export interface VaultAdapter {
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinaryAtomic(path: string, content: ArrayBuffer): Promise<void>;
  deleteFile(path: string): Promise<void>;
  /** Fresh filesystem stat (not Obsidian's cached TFile.stat). */
  stat(path: string): Promise<VaultStat>;
}

export interface SyncReport {
  uploadedCount: number;
  downloadedCount: number;
  conflictCount: number;
  deletedRemoteCount: number;
  deletedLocalCount: number;
  errors: Array<{ path: string; error: string }>;
  updatedIndex?: SyncIndex;
}

/** Returns the remote tree keyed by vault-relative path. */
export type RemoteRefresh = () => Promise<Map<string, RemoteFileItem>>;

const CONCURRENCY_LIMIT = 3;

async function runConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) {
        await fn(item);
      }
    }
  });
  await Promise.all(workers);
}

export class SyncManager {
  private client: SynologyApiClient;
  private vault: VaultAdapter;
  private remoteRoot: string;
  private currentIndex: SyncIndex;
  private refreshRemote?: RemoteRefresh;
  private isRunning: boolean = false;

  constructor(
    client: SynologyApiClient,
    vault: VaultAdapter,
    remoteRoot: string,
    currentIndex?: SyncIndex,
    refreshRemote?: RemoteRefresh
  ) {
    this.client = client;
    this.vault = vault;
    this.remoteRoot = remoteRoot.replace(/\/+$/, '');
    this.currentIndex = currentIndex ? { ...currentIndex } : {};
    this.refreshRemote = refreshRemote;
  }

  private async statOrNull(path: string): Promise<VaultStat | null> {
    try {
      return await this.vault.stat(path);
    } catch {
      return null;
    }
  }

  async executeSync(diff: DiffResult): Promise<SyncReport> {
    if (this.isRunning) {
      throw new Error('Sync is already in progress.');
    }
    this.isRunning = true;

    const updatedIndex: SyncIndex = { ...this.currentIndex };
    const touched = new Set<string>();

    const report: SyncReport = {
      uploadedCount: 0,
      downloadedCount: 0,
      conflictCount: 0,
      deletedRemoteCount: 0,
      deletedLocalCount: 0,
      errors: [],
      updatedIndex,
    };

    try {
      // 1. Uploads
      const uploads = diff.uploads || [];
      await runConcurrent(uploads, CONCURRENCY_LIMIT, async (item) => {
        try {
          const content = await this.vault.readBinary(item.path);
          const slashIdx = item.path.lastIndexOf('/');
          const folder = slashIdx !== -1 ? `${this.remoteRoot}/${item.path.substring(0, slashIdx)}` : this.remoteRoot;
          const fileName = slashIdx !== -1 ? item.path.substring(slashIdx + 1) : item.path;

          if (item.local?.mtime !== undefined) {
            await this.client.uploadFile(folder, fileName, content, item.local.mtime);
          } else {
            await this.client.uploadFile(folder, fileName, content);
          }
          report.uploadedCount++;

          // Baseline must describe what is actually on disk. The remote side is
          // filled in by the post-transfer refresh below.
          const st = await this.statOrNull(item.path);
          recordBaseline(updatedIndex, item.path, {
            localMtime: st?.mtime ?? item.local?.mtime ?? Date.now(),
            localSize: st?.size ?? content.byteLength,
            remoteMtime: st?.mtime ?? item.local?.mtime ?? Date.now(),
            remoteSize: st?.size ?? content.byteLength,
            md5: item.local?.md5,
          });
          touched.add(item.path);
        } catch (e: any) {
          report.errors.push({ path: item.path, error: e.message || String(e) });
        }
      });

      // 2. Downloads
      const downloads = diff.downloads || [];
      await runConcurrent(downloads, CONCURRENCY_LIMIT, async (item) => {
        if (!item.remote) return;
        try {
          const content = await this.client.downloadFile(item.remote.fullRemotePath);
          await this.vault.writeBinaryAtomic(item.path, content);
          report.downloadedCount++;

          const st = await this.statOrNull(item.path);
          recordBaseline(updatedIndex, item.path, {
            localMtime: st?.mtime ?? Date.now(),
            localSize: st?.size ?? content.byteLength,
            remoteMtime: item.remote.mtime,
            remoteSize: item.remote.size,
            md5: item.remote.md5,
          });
        } catch (e: any) {
          report.errors.push({ path: item.path, error: e.message || String(e) });
        }
      });

      // 3. Conflicts: keep the remote version as a side copy, never overwrite.
      //    The baseline for the original path is then recorded for BOTH sides,
      //    otherwise the next cycle re-detects the same conflict and produces a
      //    copy of the copy (this is the loop that filled a vault with 1190 files).
      const conflicts = diff.conflicts || [];
      for (const item of conflicts) {
        if (!item.remote) continue;
        try {
          const content = await this.client.downloadFile(item.remote.fullRemotePath);
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const slashIdx = item.path.lastIndexOf('/');
          const dir = slashIdx !== -1 ? item.path.substring(0, slashIdx + 1) : '';
          const fileName = slashIdx !== -1 ? item.path.substring(slashIdx + 1) : item.path;

          const extIdx = fileName.lastIndexOf('.');
          const baseName = extIdx > 0 ? fileName.substring(0, extIdx) : fileName;
          const ext = extIdx > 0 ? fileName.substring(extIdx) : '';
          const conflictPath = `${dir}${baseName} (conflict-syno-${timestamp})${ext}`;

          await this.vault.writeBinaryAtomic(conflictPath, content);
          report.conflictCount++;

          const st = await this.statOrNull(item.path);
          recordBaseline(updatedIndex, item.path, {
            localMtime: st?.mtime ?? item.local?.mtime ?? Date.now(),
            localSize: st?.size ?? item.local?.size ?? content.byteLength,
            remoteMtime: item.remote.mtime,
            remoteSize: item.remote.size,
            md5: item.remote.md5,
          });
        } catch (e: any) {
          report.errors.push({ path: item.path, error: e.message || String(e) });
        }
      }

      // 4. Remote deletions (deleted locally -> delete remotely)
      const deletesRemote = diff.deletesRemote || [];
      for (const item of deletesRemote) {
        try {
          const fullPath = item.remote?.fullRemotePath || `${this.remoteRoot}/${item.path}`;
          await this.client.deleteFile(fullPath);
          delete updatedIndex[item.path];
          report.deletedRemoteCount++;
        } catch (e: any) {
          report.errors.push({ path: item.path, error: e.message || String(e) });
        }
      }

      // 5. Local deletions (deleted remotely -> trash locally)
      const deletesLocal = diff.deletesLocal || [];
      for (const item of deletesLocal) {
        try {
          await this.vault.deleteFile(item.path);
          delete updatedIndex[item.path];
          report.deletedLocalCount++;
        } catch (e: any) {
          report.errors.push({ path: item.path, error: e.message || String(e) });
        }
      }

      // 6. Skips: always record both observed sides, even if the path was already
      //    tracked. Stale baselines are what turn "skip" into "conflict" later.
      const skips = diff.skips || [];
      for (const item of skips) {
        if (!item.local || !item.remote) continue;
        recordBaseline(updatedIndex, item.path, {
          localMtime: item.local.mtime,
          localSize: item.local.size,
          remoteMtime: item.remote.mtime,
          remoteSize: item.remote.size,
          md5: item.local.md5 || item.remote.md5,
        });
      }

      // 7. Reconcile the remote side of every path we just wrote. Synology sets
      //    its own mtime on upload, which rarely equals the local one; storing the
      //    real value here is what makes the next cycle report "unchanged".
      if (this.refreshRemote && touched.size > 0) {
        try {
          const snapshot = await this.refreshRemote();
          for (const path of touched) {
            const remote = snapshot.get(path);
            const entry = updatedIndex[path];
            if (remote && entry) {
              entry.remoteMtime = remote.mtime;
              entry.remoteSize = remote.size;
            }
          }
        } catch (e: any) {
          // A failed refresh is not fatal: the next cycle re-lists anyway and the
          // provisional baseline only costs one extra comparison.
          report.errors.push({ path: '*', error: `Remote refresh failed: ${e?.message || String(e)}` });
        }
      }
    } finally {
      this.isRunning = false;
    }

    return report;
  }
}

export async function executeSyncCycle(
  client: SynologyApiClient,
  vault: VaultAdapter,
  remoteRoot: string,
  diff: DiffResult,
  currentIndex?: SyncIndex,
  refreshRemote?: RemoteRefresh
): Promise<SyncReport> {
  const manager = new SyncManager(client, vault, remoteRoot, currentIndex, refreshRemote);
  return await manager.executeSync(diff);
}
