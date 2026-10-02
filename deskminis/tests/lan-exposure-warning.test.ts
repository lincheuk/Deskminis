/** W3-sec5 / W3-sec6（安全审计第 2 条）：设备之间的连接 W3-sec6 起已加密（tests/remote-channel.test.ts），还剩配对那一步不加密。
 *  引擎被设成监听回环以外的地址时，启动写一行提示（minisd 的 stderr 由主进程记进按天日志）；README 与 CHANGELOG 写明连接加密、
 *  配对请在可信的局域网里做——不能再说「同步是明文传输」（W3-sec5 那一版的说法，W3-sec6 之后就不对了）。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lanExposureWarning } from '../src/minisd/index';

describe('lanExposureWarning', () => {
  it.each([undefined, '', '127.0.0.1', '127.0.0.5', 'localhost', '::1', 'LOCALHOST'])('%s：只监听本机，不警告', (host) => {
    expect(lanExposureWarning(host)).toBeUndefined();
  });
  it.each(['0.0.0.0', '::', '192.168.1.10', 'my-pc.lan'])('%s：开到了本机以外，提示写明连接加密、配对不加密、在可信网络里配对', (host) => {
    const w = lanExposureWarning(host);
    expect(w).toContain(host);
    expect(w).toMatch(/连接是加密的/);
    expect(w).toMatch(/配对[\s\S]*不加密/);
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

describe('文档写明连接加密、配对那一步不加密', () => {
  const root = join(__dirname, '..', '..');
  it('README 的设备同步说明与「数据去向」表：连接加密、配对不加密、在可信局域网里配对；不再说同步是明文传输', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const rows = readme.split('\n').filter(l => l.startsWith('| 设备同步 |'));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatch(/加密/);
      expect(r).toMatch(/配对[\s\S]*不加密[\s\S]*可信/);
      expect(r).not.toMatch(/明文传输|传输是明文/);
    }
  });
  it('CHANGELOG 0.3.0：数据安全写了连接加密；已知边界写了配对不加密、两台都要 0.3.0、已配对设备等同本机', () => {
    const cl = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const s = cl.slice(cl.indexOf('## 0.3.0'), cl.indexOf('## 0.2.0'));
    const known = s.slice(s.indexOf('### 已知边界'));
    expect(s.slice(s.indexOf('### 数据安全'), s.indexOf('### 失效与界面诚实'))).toMatch(/设备之间的远程连接加密/);
    expect(known).toMatch(/配对那一步不加密/);
    expect(known).toMatch(/两台设备都要是 0\.3\.0/);
    expect(known).toMatch(/已配对的设备等同本机/);
    expect(known).not.toMatch(/同步是明文传输/);
  });
});
