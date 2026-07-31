import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noProxyDispatcher, noProxyFetch } from '../src/minisd/remote/noProxyFetch';

describe('noProxy dispatcher 配置', () => {
  it('noProxyDispatcher 存在且为 undici Agent 实例', () => {
    expect(noProxyDispatcher).toBeTruthy();
    // undici Agent 的 toString 返回 [object Object]；用 constructor.name 断言形态
    expect(noProxyDispatcher.constructor.name).toBe('Agent');
  });

  it('noProxyFetch 是函数', () => {
    expect(typeof noProxyFetch).toBe('function');
  });
});

describe('红线隔离：provider 路径不引入 noProxyFetch', () => {
  it('src/minisd/providers/ 下无 noProxyFetch import', () => {
    // 红线（设计 §3.4）：providers 的 HTTPS 必须继续走全局 fetch（尊重系统代理）
    // provider 路径禁止 import noProxyFetch——否则国内用户没代理打不到 OpenAI
    const root = join(process.cwd(), 'src', 'minisd', 'providers');
    const check = (dir: string): boolean => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (check(p)) return true; }
        else if (e.name.endsWith('.ts') && readFileSync(p, 'utf8').includes('noProxyFetch')) return true;
      }
      return false;
    };
    expect(check(root)).toBe(false);
  });
});
