import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCapturedEngine, type CapturedEngine } from './engine-assembly';
import { rendererOn, type Renderer } from './state-sync-fixture';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { catalogFixture, jsonResponse } from './runtime-model-fixture';
import { openDb } from '../src/minisd/store/db';

let engine: CapturedEngine | undefined;
let renderer: Renderer | undefined;
afterEach(async () => {
  await renderer?.close();
  await engine?.close();
  renderer = undefined;
  engine = undefined;
});

describe('N04 真实 renderer → WebSocket → 引擎的诊断接线', () => {

  it('四个接口返回实际状态、配额、自检与二次脱敏的最近审计', async () => {
    // 临时数据根与合成新鲜目录，不使用正式数据或外部模型服务。
    const root = mkdtempSync(join(tmpdir(), 'dm-n04-'));
    const catalog = new ModelCatalog(join(root, 'models-dev-cache.json'), async () => jsonResponse(catalogFixture()));
    expect(await catalog.refresh(true)).toBe(true);
    engine = await startCapturedEngine({ dataDir: root });
    const db = openDb(join(root, 'minis.db'));
    try {
      // 直接放入旧式未脱敏的合成审计，证明出口再次脱敏；总数大于一页。
      const insert = db.prepare('INSERT INTO audit_logs (id,event_type,session_id,payload_json,created_at) VALUES (?,?,?,?,?)');
      for (let i = 0; i < 25; i++) {
        insert.run('N04-' + i.toString().padStart(2, '0'), 'n04.synthetic', 'S', JSON.stringify({
          command: 'echo sk-syntheticSecret', token: 'synthetic-token', path: 'C:/synthetic/project.txt'
        }), 1000 + i);
      }
      renderer = await rendererOn({ info: () => ({ port: engine!.handle.port, token: engine!.handle.authToken, alive: true }) });
      const chat = renderer.chat;

      const proc = await chat.fetchProcSnapshot();
      expect(proc.epoch).toBeGreaterThan(0);
      expect(proc.takenAt).toBeGreaterThan(0);
      expect(proc.ownership.state).toBe('untested');
      expect(proc.trees).toEqual([]);

      const usage = await chat.fetchCheckpointUsage();
      expect(usage).toEqual({
        usedBytes: 0, blobCount: 0, checkpointCount: 0, quotaBytes: 1073741824,
        retentionDays: 30, maxFileBytes: 67108864, protectedBytes: 0, overQuota: false
      });

      const dry = await chat.runDiagnostics();
      expect(dry.overall).toBe('blocked');
      expect(dry.checks.defaultProvider).toEqual({ status: 'blocked', detail: '未配置默认 provider' });
      expect(dry.checks.processOwnership.detail).toContain('还没有启动过子进程');
      expect(dry.promptPreview).toContain('你是 DeskMinis');
      expect(dry.estimatedTokens).toBe(Math.ceil(dry.promptPreview.length / 4));

      const audit = await chat.fetchAuditRecords();
      expect(audit.total).toBe(25);
      expect(audit.rows).toHaveLength(20);
      expect(audit.rows[0]).toEqual({ id: 'N04-24', eventType: 'n04.synthetic', sessionId: 'S', payload: { command: 'echo sk-***', path: 'C:/synthetic/project.txt' } });
      expect(audit.rows.at(-1)?.id).toBe('N04-05');
      expect(JSON.stringify(audit)).not.toContain('syntheticSecret');
      expect(JSON.stringify(audit)).not.toContain('synthetic-token');
      expect(db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()).toEqual({ n: 25 });
    } finally { db.close(); }
  }, 60000);
});
