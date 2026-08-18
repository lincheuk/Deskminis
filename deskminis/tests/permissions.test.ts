import { describe, it, expect } from 'vitest';
import { classifyShellCommand, isReadonlyCommand, PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import type { PermissionRequest } from '../src/minisd/tools/types';

describe('classifyShellCommand', () => {
  it.each([
    // ---- danger（不变的灾难集）：不可逆/系统级，顺序无关 ----
    ['Remove-Item -Recurse -Force C:\\x', 'danger'],
    ['rm -r node_modules', 'danger'],
    ['del /s /q *', 'danger'],
    ['format d:', 'danger'],
    ['reg delete HKLM\\x', 'danger'],
    ['shutdown /s', 'danger'],
    ['rmdir /s build', 'danger'],
    ['Remove-Item -Force C:\\important.txt', 'danger'],
    ['dir; Remove-Item -Force C:\\x', 'danger'],
    ['Get-ChildItem -Recurse | Remove-Item -Force', 'danger'],
    // ---- danger（影子命名原语现被硬拦）：把无害名字重绑为任意行为 ----
    ['function Get-Stuff { Set-Content C:\\x -Value p }', 'danger'],
    ['Set-Alias dir Remove-Item', 'danger'],
    ['nal whoami C:\\evil\\payload.exe', 'danger'],
    ['sal x Remove-Item', 'danger'],
    ['Set-Item alias:dir -Value Remove-Item', 'danger'],
    // ---- readonly（保守子集免批）：结构上绝对简单 + 首 token 命中白名单 ----
    ['dir', 'readonly'],
    ['Get-ChildItem -Recurse', 'readonly'],
    ['Get-ChildItem -Recurse src', 'readonly'],
    ['git status', 'readonly'],
    ['git log --oneline', 'readonly'],
    ['git log --oneline -10', 'readonly'],
    ['git config --get user.name', 'readonly'],
    ['cat a.txt', 'readonly'],
    ['Get-Content 报告.txt', 'readonly'],
    ['Get-Content "a b.txt"', 'readonly'],
    ['rg "pattern" src', 'readonly'],
    ['Select-String -Path x.ts -Pattern foo', 'readonly'],
    ['Git STATUS', 'readonly'], // 白名单比较不区分大小写
    ['node --version', 'readonly'],
    ['npm ls', 'readonly'],
    // branch/remote 双形态：列表读免批（restFlagsOnly 审查补丁）
    ['git branch', 'readonly'],
    ['git branch -a', 'readonly'],
    ['git branch --show-current', 'readonly'],
    ['git remote', 'readonly'],
    ['git remote -v', 'readonly'],
    // ---- gated（其余一切非危险：复合结构 / 白名单外 / 二段 token 不放行）----
    ['npm install', 'gated'],
    ['npm config set registry x', 'gated'], // npm config 只放行 get 形态；写配置必须问
    ['git push', 'gated'],
    ['git checkout .', 'gated'],
    ['git config user.name', 'gated'], // 读写形态暧昧（无 --get 时可能是写），回落询问
    // branch/remote 的写形态：任何非旗标参数都不许坐只读通道（建/删分支、写 .git/config）
    ['git branch feature-x', 'gated'],
    ['git branch -D main', 'gated'],
    ['git remote add origin https://github.com/x/y', 'gated'],
    ['python app.py', 'gated'], // python 只放行版本旗标；跑脚本一律问
    ['node -e "process.exit(1)"', 'gated'], // node 只放行版本旗标；-e 执行任意代码
    // 误报缓解仍在：散文里的短别名不在命令位，不判危险，落入 gated（用户仍会被询问）
    ['git commit -m "del old code"', 'gated'],
    ['echo "rm is dangerous"', 'gated'],
    // 结构过滤：任何管道/复合/子表达式/重定向/splatting/引号异常一律不收
    ['gci; rm x', 'danger'], // 分号后的 rm 命中既有命令位危险表 → danger 优先（比 gated 更严）
    ['Get-Content $(rm x)', 'danger'], // '(' 属命令位危险字符类，同上
    ['gci | ForEach-Object { rm $_ }', 'gated'],
    ['Get-Content `whoami`', 'gated'], // 反引号命令替换
    ['echo hi > f.txt', 'gated'], // 重定向写文件 + echo 白名单外
    ['Get-Content "a.txt', 'gated'], // 引号未配对 → 结构不明
    ['rg "$pattern" src', 'gated'], // 引号内含 $ → 可能展开，不收
    ['&{rm x}', 'gated'], // 调用符 + 脚本块
    ['cmd /c del x', 'gated'], // cmd 白名单外；嵌套 shell 一律问
    ['Get-Content (Set-Content C:\\x -Value p)', 'gated'], // 裸括号是表达式求值，若放行会静默写文件
    // former bypasses（git --output / 裸括号 / UNC 求值形态）仍只是 gated → 走确认
    ['git diff --output=C:\\tmp\\a.txt', 'gated'], // git 家族 --output 把 diff 写入文件，旗标前缀后门拒绝
    ['echo (Set-Content C:\\x -Value p)', 'gated'],
  ])('%s → %s', (cmd, cls) => { expect(classifyShellCommand(cmd)).toBe(cls); });
});

describe('isReadonlyCommand（保守子集结构过滤）', () => {
  it('trim 归一化与空白分隔：制表符分隔同样按 token 解析', () => {
    expect(isReadonlyCommand('  git\tstatus  ')).toBe(true);
  });

  it('空串与裸命令名回落：裸 git/node 无只读语义（帮助/REPL），不收', () => {
    expect(isReadonlyCommand('')).toBe(false);
    expect(isReadonlyCommand('   ')).toBe(false);
    expect(isReadonlyCommand('git')).toBe(false);
    expect(isReadonlyCommand('node')).toBe(false);
  });

  it('& 调用符前缀不收：结构过滤已拒绝一切 &，防御性再验一次', () => {
    expect(isReadonlyCommand('& git status')).toBe(false);
  });

  it('引号外裸 $ 变量引用可放行：变量读取无执行语义', () => {
    expect(isReadonlyCommand('Get-Content $file')).toBe(true);
  });

  it('引号内含 $ 或反引号一律不收（防字符串内展开）', () => {
    expect(isReadonlyCommand('rg "$pattern" src')).toBe(false);
    expect(isReadonlyCommand("rg 'a$b' f")).toBe(false);
    expect(isReadonlyCommand('Get-Content "a `b`"')).toBe(false);
  });

  it('引号必须配对：跨引号混用（双引号包单引号）结构完整可放行', () => {
    expect(isReadonlyCommand("rg \"it's here\" src")).toBe(true);
    expect(isReadonlyCommand("Get-Content 'a b.txt'")).toBe(true);
  });
});

const req = (detail: string, sessionId = 'S1'): PermissionRequest => ({ kind: 'shell', detail, sessionId, toolTitle: 't' });

describe('PermissionGatewayImpl', () => {
  it('danger 硬拦：即便 prompt 返回 allow-once 仍 deny，且从不询问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    expect(await g.check(req('Remove-Item -Recurse C:\\'))).toBe('deny');
    expect(asked).toBe(0);
  });

  it('readonly 免批静默放行：即便 prompt 设为 deny 也不弹卡', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    expect(await g.check(req('git status'))).toBe('allow');
    expect(await g.check(req('dir'))).toBe('allow');
    expect(asked).toBe(0);
  });

  it('readonly 档可被自定义级别收紧：askOnce 恢复询问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; }, { readonly: 'askOnce' });
    expect(await g.check(req('git status'))).toBe('allow');
    expect(asked).toBe(1);
  });

  it('gated 命令首次遭遇仍必问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    expect(await g.check(req('npm install'))).toBe('deny');
    expect(asked).toBe(1);
  });

  it('allow-once 不持久：同命令两次都要问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    expect(await g.check(req('npm install'))).toBe('allow');
    expect(await g.check(req('npm install'))).toBe('allow');
    expect(asked).toBe(2);
  });

  it('allow-session 按精确命令持久；不同命令串重新问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(req('npm test'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(req('npm test'))).toBe('allow'); // 同串原样重复 → 静默
    expect(asked).toBe(1);
    expect(await g.check(req('npm run build'))).toBe('allow'); // 不同串 → 重新问
    expect(asked).toBe(2);
  });

  it('会话批准按会话隔离：S1 批准不影响 S2', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(req('npm test'))).toBe('allow'); // S1
    expect(asked).toBe(1);
    expect(await g.check(req('npm test', 'S2'))).toBe('allow'); // S2 重新问
    expect(asked).toBe(2);
  });

  it('询问超时 → deny', async () => {
    const g = new PermissionGatewayImpl(() => new Promise(() => { /* 永不响应 */ }), undefined, 50);
    expect(await g.check(req('npm install'))).toBe('deny');
  });

  it('file-write 按路径 askOnce：allow-session 后同路径静默，不同路径重新问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    const fw = (detail: string): PermissionRequest => ({ kind: 'file-write', detail, sessionId: 'S1', toolTitle: 't' });
    expect(await g.check(fw('C:\\x.txt'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(fw('C:\\x.txt'))).toBe('allow'); // 同路径 → 静默
    expect(asked).toBe(1);
    expect(await g.check(fw('C:\\y.txt'))).toBe('allow'); // 不同路径 → 重新问
    expect(asked).toBe(2);
  });

  const fr = (detail: string): PermissionRequest => ({ kind: 'file-read', detail, sessionId: 'S1', toolTitle: 't' });

  it('file-read 默认 askOnce：数据根外的读取必须问过用户，deny 即拒', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    expect(await g.check(fr('C:\\Users\\u\\.ssh\\id_rsa'))).toBe('deny');
    expect(asked).toBe(1);
  });

  it('file-read 按路径记忆：allow-session 后同路径静默，不同路径重新问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(fr('C:\\a.txt'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(fr('C:\\a.txt'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(fr('C:\\b.txt'))).toBe('allow');
    expect(asked).toBe(2);
  });

  it('file-read 的 detail 是路径，不走 shell 分类器（含危险词的路径仍然只是询问）', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    // 作为 shell 命令这条会被判 danger（\bdiskpart\b）→ 若路由错误就会静默 deny 且从不询问
    expect(await g.check(fr('C:\\tools\\diskpart\\notes.txt'))).toBe('allow');
    expect(asked).toBe(1);
  });

  it('file-read 与 file-write 的会话批准互不串用', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(fr('C:\\x.txt'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check({ kind: 'file-write', detail: 'C:\\x.txt', sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    expect(asked).toBe(2); // 读的批准不等于写的批准
  });
});

describe('桥类目（M2e 扩展）', () => {
  const bridgeReq = (kind: PermissionRequest['kind'], detail: string, sessionId = 'S1'): PermissionRequest =>
    ({ kind, detail, sessionId, toolTitle: 't' });

  it('bridge-device 默认 bypass：放行且从不询问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    expect(await g.check(bridgeReq('bridge-device', 'windows-device info'))).toBe('allow');
    expect(asked).toBe(0);
  });

  it('bridge-clipboard-read / bridge-screenshot 默认 askOnce：先问，allow-session 后按能力串静默', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(bridgeReq('bridge-clipboard-read', 'windows-clipboard get'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(bridgeReq('bridge-clipboard-read', 'windows-clipboard get'))).toBe('allow'); // 同能力 → 静默
    expect(asked).toBe(1);
    expect(await g.check(bridgeReq('bridge-screenshot', 'windows-screenshot capture'))).toBe('allow'); // 不同能力 → 重新问
    expect(asked).toBe(2);
  });

  it('六个 askOnce 桥类目逐个验证：notify/open/speak/clipboard-read/clipboard-write/screenshot', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    const cases: PermissionRequest['kind'][] = [
      'bridge-notify', 'bridge-open', 'bridge-speak',
      'bridge-clipboard-read', 'bridge-clipboard-write', 'bridge-screenshot',
    ];
    for (const kind of cases) {
      expect(await g.check(bridgeReq(kind, `detail-of-${kind}`))).toBe('allow');
    }
    expect(asked).toBe(6); // allow-once 不持久，每个类目都问了
  });

  it('桥 kind 不经 shell 分类器：detail 含危险词也只是按桥级别询问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    // 'Remove-Item' 作为 shell 命令是 danger → 若路由错误会静默 deny 且从不询问（对齐 M1 file-read 路由回归用例）
    expect(await g.check(bridgeReq('bridge-notify', 'Remove-Item'))).toBe('allow');
    expect(asked).toBe(1);
  });

  it('桥授权按会话隔离：S1 的 allow-session 不惠及 S2', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(bridgeReq('bridge-open', 'windows-open open', 'S1'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(bridgeReq('bridge-open', 'windows-open open', 'S2'))).toBe('allow');
    expect(asked).toBe(2);
  });

  it('既有行为不回归：danger 硬拦不问、gated 问、file-read 问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    expect(await g.check({ kind: 'shell', detail: 'Remove-Item -Recurse C:\\x', sessionId: 'S1', toolTitle: 't' })).toBe('deny');
    expect(asked).toBe(0);
    expect(await g.check({ kind: 'shell', detail: 'npm install', sessionId: 'S1', toolTitle: 't' })).toBe('allow'); // gated 代表
    expect(asked).toBe(1);
    expect(await g.check({ kind: 'file-read', detail: 'C:\\a.txt', sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    expect(asked).toBe(2);
  });
});

describe('web-fetch 类目', () => {
  const wf = (detail: string): PermissionRequest => ({ kind: 'web-fetch', detail, sessionId: 'S1', toolTitle: 't' });

  it('默认 askOnce：先问，allow 后放行', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    expect(await g.check(wf('https://example.com/a'))).toBe('allow');
    expect(asked).toBe(1);
  });

  it("applyPreset('full') 后 bypass：放行且从不询问", async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    g.applyPreset('full');
    expect(await g.check(wf('https://example.com/a'))).toBe('allow');
    expect(asked).toBe(0);
  });

  it("applyPreset('ask') 从 full 恢复默认询问", async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    g.applyPreset('full');
    g.applyPreset('ask');
    expect(await g.check(wf('https://example.com/a'))).toBe('deny');
    expect(asked).toBe(1);
  });

  it('web-fetch 的 detail 是 URL，不走 shell 分类器（含危险词的 URL 仍只是询问）', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    // 'shutdown' 作为 shell 命令是 danger → 若误路由到分类器会静默 deny 且从不询问
    expect(await g.check(wf('https://example.com/?q=shutdown+servers'))).toBe('allow');
    expect(asked).toBe(1);
  });
});

describe('applyPreset（权限选择器三档真实作用于网关）', () => {
  it("'full' 放行 gated/file-read/file-write 与全部 bridge-*，且从不询问", async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    g.applyPreset('full');
    expect(await g.check(req('npm install'))).toBe('allow'); // gated
    expect(await g.check(req('git status'))).toBe('allow'); // readonly 在 full 下同样放行
    expect(await g.check({ kind: 'file-read', detail: 'C:\\a.txt', sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    expect(await g.check({ kind: 'file-write', detail: 'C:\\b.txt', sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    // 桥七类全部放行
    const bridgeKinds: PermissionRequest['kind'][] = [
      'bridge-notify', 'bridge-clipboard-read', 'bridge-clipboard-write',
      'bridge-open', 'bridge-speak', 'bridge-screenshot', 'bridge-device',
    ];
    for (const kind of bridgeKinds) expect(await g.check({ kind, detail: `detail-${kind}`, sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    expect(asked).toBe(0);
  });

  it("'full' 下 danger 仍 deny（不可逆系统操作拦截）且从不询问", async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    g.applyPreset('full');
    expect(await g.check(req('Remove-Item -Recurse C:\\'))).toBe('deny');
    expect(asked).toBe(0);
  });

  it("'full' 切回 'ask'：恢复询问（gated 不再静默放行，readonly 免批不受预设影响）", async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    g.applyPreset('full');
    expect(await g.check(req('npm install'))).toBe('allow');
    expect(asked).toBe(0);
    g.applyPreset('ask');
    expect(await g.check(req('npm install'))).toBe('deny');
    expect(asked).toBe(1); // 恢复询问
    expect(await g.check(req('git status'))).toBe('allow'); // readonly 是档位常量，切档仍免批
    expect(asked).toBe(1);
  });

  it("'session' 与 'ask' 网关行为一致（都恢复 DEFAULT_LEVELS）", async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    g.applyPreset('full');
    g.applyPreset('session');
    expect(await g.check(req('npm install'))).toBe('deny');
    expect(asked).toBe(1);
  });
});
