import { describe, it, expect } from 'vitest';
import { SynologyApiClient, type HttpRequestOptions } from '../src/syno/api-client';
import { QuickConnectResolver } from '../src/syno/qc-resolver';
import { computeDiff } from '../src/sync/diff-engine';
import { SyncManager, type VaultAdapter, type RemoteRefresh } from '../src/sync/sync-manager';
import type { LocalFileItem, RemoteFileItem, SyncIndex } from '../src/types';

describe('Synology DSM protocol formatting', () => {
  it('listFiles sends JSON-encoded additional=["time","size"] and parses mtime in ms', async () => {
    const seenUrls: string[] = [];
    const client = new SynologyApiClient('https://nas.local:5001', async (opts: HttpRequestOptions) => {
      seenUrls.push(opts.url);
      return {
        status: 200,
        json: {
          success: true,
          data: {
            total: 1,
            files: [
              {
                name: 'note.md',
                path: '/vault/note.md',
                isdir: false,
                additional: {
                  size: 1234,
                  time: { mtime: 1794924000 },
                },
              },
            ],
          },
        },
      };
    });
    client.setSid('test_sid');

    const files = await client.listFiles('/vault');
    expect(seenUrls).toHaveLength(1);
    const parsedUrl = new URL(seenUrls[0]);
    expect(parsedUrl.searchParams.get('additional')).toBe('["time","size"]');
    expect(files).toEqual([
      {
        path: 'note.md',
        fullRemotePath: '/vault/note.md',
        isdir: false,
        mtime: 1794924000000,
        size: 1234,
        md5: undefined,
      },
    ]);
  });

  it('uploadFile sends mtime in milliseconds (converting seconds if needed)', async () => {
    const capturedBodies: string[] = [];
    const client = new SynologyApiClient('https://nas.local:5001', async (opts: HttpRequestOptions) => {
      const buf = opts.body as ArrayBuffer;
      capturedBodies.push(new TextDecoder().decode(new Uint8Array(buf)));
      return { status: 200, json: { success: true, data: { file: 'a.md' } } };
    });
    client.setSid('test_sid');

    const payload = new TextEncoder().encode('hello').buffer;
    await client.uploadFile('/vault', 'a.md', payload, 1794924000123);
    await client.uploadFile('/vault', 'b.md', payload, 1794924000);

    expect(capturedBodies[0]).toContain('name="mtime"\r\n\r\n1794924000123\r\n');
    expect(capturedBodies[1]).toContain('name="mtime"\r\n\r\n1794924000000\r\n');
  });
});

describe('QuickConnectResolver LAN protocol order', () => {
  it('prefers HTTPS over HTTP on LAN when both respond, and falls back to HTTP if HTTPS fails', async () => {
    const serverInfoPayload = [
      {
        errno: 0,
        id: 'mainapp_https',
        server: {
          interface: [{ ip: '192.168.31.109' }],
        },
        service: {
          port: 5001,
        },
      },
      {
        errno: 0,
        id: 'mainapp_http',
        server: {
          interface: [{ ip: '192.168.31.109' }],
        },
        service: {
          port: 5000,
        },
      },
    ];

    const resolverBoth = new QuickConnectResolver(
      async (url) => url.startsWith('https://192.168.31.109:5001') || url.startsWith('http://192.168.31.109:5000'),
      async () => serverInfoPayload
    );
    expect(await resolverBoth.resolveBaseUrl('my-nas')).toBe('https://192.168.31.109:5001');

    const resolverHttpOnly = new QuickConnectResolver(
      async (url) => url.startsWith('http://192.168.31.109:5000'),
      async () => serverInfoPayload
    );
    expect(await resolverHttpOnly.resolveBaseUrl('my-nas')).toBe('http://192.168.31.109:5000');
  });
});

describe('legacy remoteMtime=0 baseline migration', () => {
  it('skips unchanged files and catches remote size changes without mass downloads or conflicts', async () => {
    const localFiles: LocalFileItem[] = [
      { path: 'same.md', mtime: 1794900000000, size: 100 },
      { path: 'remote-edited.md', mtime: 1794900000000, size: 200 },
      { path: 'local-edited.md', mtime: 1794950000000, size: 310 },
    ];
    const remoteFiles: RemoteFileItem[] = [
      // Simulate damaged 1970 mtime on NAS + same size
      { path: 'same.md', fullRemotePath: '/v/same.md', isdir: false, mtime: 1794900000, size: 100 },
      // Simulate external remote edit on NAS (size 200 -> 240)
      { path: 'remote-edited.md', fullRemotePath: '/v/remote-edited.md', isdir: false, mtime: 1794960000000, size: 240 },
      { path: 'local-edited.md', fullRemotePath: '/v/local-edited.md', isdir: false, mtime: 1794900000, size: 300 },
    ];
    const legacyIndex: SyncIndex = {
      'same.md': { localMtime: 1794900000000, remoteMtime: 0, size: 100, remoteSize: 0 },
      'remote-edited.md': { localMtime: 1794900000000, remoteMtime: 0, size: 200, remoteSize: 0 },
      'local-edited.md': { localMtime: 1794900000000, remoteMtime: 0, size: 300, remoteSize: 0 },
    };

    const diff = computeDiff(localFiles, remoteFiles, [], legacyIndex);
    expect(diff.skips.map((x) => x.path)).toEqual(['same.md']);
    expect(diff.downloads.map((x) => x.path)).toEqual(['remote-edited.md']);
    expect(diff.uploads.map((x) => x.path)).toEqual(['local-edited.md']);
    expect(diff.conflicts).toHaveLength(0);

    // Executing sync heals remoteMtime & remoteSize for skipped file too
    const memVault = new Map<string, { bytes: Uint8Array; mtime: number }>([
      ['same.md', { bytes: new Uint8Array(100), mtime: 1794900000000 }],
      ['remote-edited.md', { bytes: new Uint8Array(200), mtime: 1794900000000 }],
      ['local-edited.md', { bytes: new Uint8Array(310), mtime: 1794950000000 }],
    ]);
    const vaultAdapter: VaultAdapter = {
      readBinary: async (p) => memVault.get(p)!.bytes.buffer.slice(0) as ArrayBuffer,
      writeBinaryAtomic: async (p, c) => {
        memVault.set(p, { bytes: new Uint8Array(c.slice(0)), mtime: 1794965000000 });
      },
      deleteFile: async (p) => {
        memVault.delete(p);
      },
      stat: async (p) => {
        const f = memVault.get(p)!;
        return { mtime: f.mtime, size: f.bytes.byteLength };
      },
    };
    const fakeClient = {
      uploadFile: async () => {},
      downloadFile: async () => new Uint8Array(240).buffer,
      deleteFile: async () => {},
    };
    const refresh: RemoteRefresh = async () =>
      new Map([
        ['same.md', remoteFiles[0]],
        ['remote-edited.md', remoteFiles[1]],
        ['local-edited.md', { path: 'local-edited.md', fullRemotePath: '/v/local-edited.md', isdir: false, mtime: 1794950000000, size: 310 }],
      ]);

    const manager = new SyncManager(fakeClient as any, vaultAdapter, '/v', legacyIndex, refresh);
    const report = await manager.executeSync(diff);
    expect(report.updatedIndex?.['same.md'].remoteMtime).toBe(1794900000);
    expect(report.updatedIndex?.['same.md'].remoteSize).toBe(100);
    expect(report.updatedIndex?.['remote-edited.md'].remoteSize).toBe(240);
    expect(report.updatedIndex?.['local-edited.md'].remoteSize).toBe(310);
  });
});
