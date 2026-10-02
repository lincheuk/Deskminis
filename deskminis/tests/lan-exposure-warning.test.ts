/** W3-sec5（安全审计第 2 条的 0.3.0 部分）：跨机器的设备同步走明文 WebSocket（聊天内容、握手里的令牌都看得见），
 *  加密通道排在之后一波。0.3.0 先把话说清楚：引擎被设成监听回环以外的地址时，启动写一行警告（minisd 的 stderr 由主进程记进按天日志），
 *  README 与 CHANGELOG 写明只在可信的局域网里用。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lanExposureWarning } from '../src/minisd/index';

describe('lanExposureWarning', () => {
  it.each([undefined, '', '127.0.0.1', '127.0.0.5', 'localhost', '::1', 'LOCALHOST'])('%s：只监听本机，不警告', (host) => {
    expect(lanExposureWarning(host)).toBeUndefined();
  });
  it.each(['0.0.0.0', '::', '192.168.1.10', 'my-pc.lan'])('%s：开到了本机以外，警告写明明文、只在可信网络里用', (host) => {
    const w = lanExposureWarning(host);
    expect(w).toContain(host);
    expect(w).toMatch(/明文/);
    expect(w).toMatch(/可信/);
  });
  it('standalone 启动分支在起引擎之前写这行警告（经 stderr 进按天日志）', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'minisd', 'index.ts'), 'utf8');
    const at = src.indexOf("if (process.env.DESKMINIS_STANDALONE === '1') {");
    const branch = src.slice(at, src.indexOf('const starting = startMinisd(startOpts);', at));
    expect(at).toBeGreaterThan(-1);
    expect(branch).toMatch(/const lanWarning = lanExposureWarning\(process\.env\.MINISD_HOST\);\s*if \(lanWarning\) process\.stderr\.write\(/);
  });
});

describe('文档写明跨机器同步是明文', () => {
  const root = join(__dirname, '..', '..');
  it('README 的设备同步说明与「数据去向」表都写了明文、只在可信局域网用', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const rows = readme.split('\n').filter(l => l.startsWith('| 设备同步 |'));
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatch(/明文[\s\S]*可信/);
  });
  it('CHANGELOG 0.3.0 的已知边界写了明文传输与「已配对设备等同本机」', () => {
    const cl = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const s = cl.slice(cl.indexOf('## 0.3.0'), cl.indexOf('## 0.2.0'));
    const known = s.slice(s.indexOf('### 已知边界'));
    expect(known).toMatch(/明文/);
    expect(known).toMatch(/已配对的设备等同本机/);
  });
});
