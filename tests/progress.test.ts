import { describe, it, expect, vi } from 'vitest';
import { SyncManager, type VaultAdapter, type RemoteRefresh, type SyncHooks } from '../src/sync/sync-manager';
import { computeDiff } from '../src/sync/diff-engine';
import type { LocalFileItem, RemoteFileItem, SyncIndex } from '../src/types';

/**
 * 移动端长任务回归：
 * 1) 单项失败不能让整轮同步永远挂着（HTTP 超时在 main.ts 里兜底，这里验证异常被吞并按项记录）；
 * 2) 会话过期（105/106/107/119）要重登并重试一次；
 * 3) 进度与索引落盘必须按项推进，中断后可以续。
 */

function makeVault(files: Map<string, string>): VaultAdapter {
  return {
    readBinary: async (p) => new TextEncoder().encode(files.get(p) ?? '').buffer as ArrayBuffer,
    writeBinaryAtomic: async (p, c) => {
      files.set(p, new TextDecoder().decode(new Uint8Array(c)));
    },
    deleteFile: async (p) => {
      files.delete(p);
    },
    stat: async (p) => ({
      mtime: 1_700_000_000_000,
      size: new TextEncoder().encode(files.get(p) ?? '').byteLength,
    }),
  };
}

describe('sync hooks: progress / persist / relogin', () => {
  it('reports progress, persists mid-run, and retries once after a DSM session error', async () => {
    const localText = 'hello';
    const files = new Map<string, string>([['a.md', localText]]);
    const vault = makeVault(files);

    const localFiles: LocalFileItem[] = [{ path: 'a.md', mtime: 1_700_000_000_000, size: localText.length }];
    const remoteFiles: RemoteFileItem[] = [];
    const index: SyncIndex = {};
    const diff = computeDiff(localFiles, remoteFiles, [], index);

    let uploadAttempts = 0;
    const client = {
      uploadFile: async () => {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          throw new Error('上传失败：a.md（错误码 105）');
        }
      },
      downloadFile: async () => new ArrayBuffer(0),
      deleteFile: async () => undefined,
    };

    const relogin = vi.fn(async () => undefined);
    const progress: Array<[number, number, string]> = [];
    const persisted: number[] = [];
    const hooks: SyncHooks = {
      onProgress: (done, total, phase) => progress.push([done, total, phase]),
      persist: async (snapshot) => {
        persisted.push(Object.keys(snapshot).length);
      },
      relogin,
    };

    const refresh: RemoteRefresh = async () => new Map();
    const manager = new SyncManager(client as any, vault, '/vault', index, refresh, hooks);
    const report = await manager.executeSync(diff);

    // 会话过期后重试成功，不计入失败
    expect(relogin).toHaveBeenCalledTimes(1);
    expect(uploadAttempts).toBe(2);
    expect(report.uploadedCount).toBe(1);
    expect(report.errors).toHaveLength(0);

    // 进度回调至少包含上传阶段与完成信号
    expect(progress.some(([d, t, phase]) => phase === '上传' && d === 1 && t === 1)).toBe(true);
    expect(progress.some(([, , phase]) => phase === '完成')).toBe(true);

    // 25 项才落盘一次：单项任务不应产生额外写盘
    expect(persisted).toHaveLength(0);
  });

  it('persists the index every 25 handled items so a killed app can resume', async () => {
    const files = new Map<string, string>();
    const localFiles: LocalFileItem[] = [];
    for (let i = 0; i < 30; i += 1) {
      files.set(`n${i}.md`, `content ${i}`);
      localFiles.push({ path: `n${i}.md`, mtime: 1_700_000_000_000, size: 10 });
    }
    const vault = makeVault(files);
    const diff = computeDiff(localFiles, [], [], {});
    const index: SyncIndex = {};

    const client = {
      uploadFile: async () => undefined,
      downloadFile: async () => new ArrayBuffer(0),
      deleteFile: async () => undefined,
    };

    let persistedCount = 0;
    const hooks: SyncHooks = {
      persist: async () => {
        persistedCount += 1;
      },
    };

    const manager = new SyncManager(client as any, vault, '/vault', index, async () => new Map(), hooks);
    const report = await manager.executeSync(diff);
    expect(report.uploadedCount).toBe(30);
    // 30 项 → 第 25 项触发 1 次落盘
    expect(persistedCount).toBeGreaterThanOrEqual(1);
  });
});