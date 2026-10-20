import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';

let dir: string;
let cacheFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dm-metadata-'));
  cacheFile = join(dir, 'catalog.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const specifications = {
  google: { models: { 'multimodal-1': {
    name: 'Multimodal 1', limit: { context: 1000000, input: 900000, output: 65000 },
    reasoning: true, tool_call: true, structured_output: false,
    modalities: { input: ['text', 'image', 'audio', 'video', 'pdf'], output: ['text'] },
  } } },
  reseller: { models: { 'multimodal-1': {
    limit: { context: 128000, output: 8000 }, reasoning: false, tool_call: false,
    modalities: { input: ['text'], output: ['text'] },
  } } },
};
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });

describe('models.dev metadata', () => {
  it('uses the public catalog without credentials and preserves input/output and agent capabilities', async () => {
    let calledUrl: unknown;
    let calledInit: RequestInit | undefined;
    const catalog = new ModelCatalog(cacheFile, async (url, init) => {
      calledUrl = url; calledInit = init;
      return response(specifications);
    });
    await catalog.refresh(true);
    expect(String(calledUrl)).toBe('https://models.dev/api.json?type=all');
    expect(calledInit?.headers).toBeUndefined();
    expect(calledInit?.signal).toBeInstanceOf(AbortSignal);
    expect(catalog.getModelMetadata('multimodal-1', 'google')).toMatchObject({
      source: 'models.dev', providerId: 'google', match: 'provider',
      contextWindow: 1000000, maxInputTokens: 900000, maxOutputTokens: 65000,
      thinking: true, toolCall: true, structuredOutput: false,
      inputModalities: ['audio', 'image', 'pdf', 'text', 'video'], outputModalities: ['text'],
    });
  });

  it('isolates same-name models per provider and resolves provider/model IDs', async () => {
    const catalog = new ModelCatalog(cacheFile, async () => response(specifications));
    await catalog.refresh(true);
    expect(catalog.getModelMetadata('google/multimodal-1').inputModalities).toContain('video');
    expect(catalog.getModelMetadata('multimodal-1', 'reseller')).toMatchObject({
      contextWindow: 128000, toolCall: false, inputModalities: ['text'],
    });
    expect(catalog.getModelMetadata('multimodal-1', 'missing-provider')).toMatchObject({
      source: 'unknown', match: 'unknown',
    });
  });

  it('marks conflicting or missing aggregate capabilities unknown instead of merging them into support', async () => {
    const catalog = new ModelCatalog(cacheFile, async () => response(specifications));
    await catalog.refresh(true);
    const metadata = catalog.getModelMetadata('multimodal-1');
    expect(metadata.match).toBe('aggregate');
    expect(metadata.inputModalities).toBeUndefined();
    expect(metadata.toolCall).toBeUndefined();
    expect(metadata.structuredOutput).toBeUndefined();
    expect(metadata.thinking).toBeUndefined();
    expect(metadata.outputModalities).toEqual(['text']);
  });

  it('persists provider metadata and its source/date across offline restarts', async () => {
    const catalog = new ModelCatalog(cacheFile, async () => response(specifications));
    await catalog.refresh(true);
    const before = catalog.getModelMetadata('multimodal-1', 'google');
    const offline = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(offline.getModelMetadata('multimodal-1', 'google')).toEqual(before);
    expect(await offline.refresh(true)).toBe(false);
    expect(offline.getModelMetadata('multimodal-1', 'google')).toEqual(before);
    expect(offline.getStatus()).toMatchObject({ primarySource: 'models.dev', source: 'models.dev', modelCount: 1 });
  });

  it('refreshes version 2 caches that do not contain media or provider records', async () => {
    writeFileSync(cacheFile, JSON.stringify({ mergeRule: 2, source: 'models.dev', fetchedAt: Date.now(), models: { 'multimodal-1': { contextWindow: 128000 } } }));
    const catalog = new ModelCatalog(cacheFile, async () => response(specifications));
    expect(await catalog.refresh()).toBe(true);
    expect(catalog.getModelMetadata('multimodal-1', 'google').inputModalities).toContain('video');
  });

  it('keeps the last successful primary catalog when the primary is unavailable and the backup is less complete', async () => {
    let offline = false;
    const catalog = new ModelCatalog(cacheFile, async (url) => {
      if (!offline) return response(specifications);
      if (String(url).includes('models.dev')) throw new Error('offline');
      return response({ success: true, data: [{ model_name: 'multimodal-1', vendor_name: 'Other', tags: '64K' }] });
    });
    await catalog.refresh(true);
    offline = true;
    expect(await catalog.refresh(true)).toBe(false);
    expect(catalog.getModelMetadata('multimodal-1', 'google').inputModalities).toContain('video');
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).source).toBe('models.dev');
  });

  it.each([null, [], {}, { google: { models: { broken: { limit: { context: -1, output: '8000' } } } } }])(
    'rejects malformed/empty data without replacing the last successful cache: %j', async (bad) => {
      let data: unknown = specifications;
      const catalog = new ModelCatalog(cacheFile, async () => response(data));
      await catalog.refresh(true);
      const original = readFileSync(cacheFile, 'utf8');
      data = bad;
      expect(await catalog.refresh(true)).toBe(false);
      expect(readFileSync(cacheFile, 'utf8')).toBe(original);
    },
  );

  it('keeps absent flags unknown and supports zero text output for specialized models', async () => {
    const catalog = new ModelCatalog(cacheFile, async () => response({ images: { models: {
      generator: { limit: { output: 0 }, modalities: { input: ['text'], output: ['image'] } },
    } } }));
    await catalog.refresh(true);
    expect(catalog.getModelMetadata('generator', 'images')).toMatchObject({ maxOutputTokens: 0, outputModalities: ['image'] });
    expect(catalog.getModelMetadata('generator', 'images').thinking).toBeUndefined();
    expect(catalog.getModelMetadata('generator', 'images').toolCall).toBeUndefined();
  });

  it('coalesces concurrent refreshes so startup and UI cannot race the atomic cache write', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const catalog = new ModelCatalog(cacheFile, async () => {
      calls++; await gate; return response(specifications);
    });
    const startup = catalog.refresh();
    const manual = catalog.refresh(true);
    release();
    expect(await Promise.all([startup, manual])).toEqual([true, true]);
    expect(calls).toBe(1);
  });

  it('does not infer multimedia capabilities from family-prefix fallback values', () => {
    const catalog = new ModelCatalog(cacheFile, async () => { throw new Error('offline'); });
    expect(catalog.getModelMetadata('claude-future')).toMatchObject({ source: 'builtin', match: 'builtin' });
    expect(catalog.getModelMetadata('claude-future').inputModalities).toBeUndefined();
    expect(catalog.getModelMetadata('mystery')).toMatchObject({ source: 'unknown', match: 'unknown' });
  });
});
