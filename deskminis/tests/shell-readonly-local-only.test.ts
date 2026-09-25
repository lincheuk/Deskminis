/**
 * W1b-2g · shell 免询问白名单只留「只读本地」的命令（止血设计稿 §4.1 W1b-2g 一行）。
 *
 * readonly 类默认 bypass、任何档位都不询问。审查发现白名单里有几种写法其实会访问外部网络或别的机器，
 * 或把环境变量（可能含各类 API key）读进工具结果：
 * ① npm view / outdated 要连 npm 源（view 还接受任意网址）；
 * ② 只读命令点到远程共享路径（\\host\share、//host/share、\\?\UNC\…、\\.\ 设备路径、WebDAV、FileSystem::\\host）；
 * ③ 不带 $ 的 env: 提供程序路径（Get-ChildItem env:、gci Env:\、Get-Content env:PATH）。
 * 这些改判 gated：按档位询问，用户同意就照常执行，功能不受影响。
 *
 * 每条都用真网关 PermissionGatewayImpl + applyPreset('ask') 走一遍：应当询问恰好 1 次；
 * 放行对照（npm ls、git log、本地相对路径、搜 https:// 字样、盘符后的 C:\\ 本地路径等）照旧零询问。
 */
import { describe, it, expect } from 'vitest';
import { classifyShellCommand, PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import type { PermissionRequest } from '../src/minisd/tools/types';

const req = (detail: string): PermissionRequest => ({ kind: 'shell', detail, sessionId: 'S1', toolTitle: '看看' });

/** 默认档（'ask'）网关跑一条命令：返回网关的决定与询问次数。询问时答「允许一次」——gated 照样能执行，只是先问。 */
async function askCount(cmd: string): Promise<{ decision: string; asked: number }> {
  let asked = 0;
  const gw = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
  gw.applyPreset('ask');
  const decision = await gw.check(req(cmd));
  return { decision, asked };
}

function expectGated(cases: string[]): void {
  it.each(cases)('%s → gated，默认档询问 1 次', async (cmd) => {
    expect(classifyShellCommand(cmd)).toBe('gated');
    expect(await askCount(cmd)).toEqual({ decision: 'allow', asked: 1 });
  });
}

describe('① npm view / outdated 连 npm 源，移出免询问', () => {
  expectGated([
    'npm view left-pad',
    'npm view left-pad versions',
    'npm view https://registry.example.com/some-pkg',
    'npm outdated',
    'npm outdated --json',
    'NPM VIEW left-pad', // 白名单比较不区分大小写，改判也一样
    'npm view left-pad | Select-Object -First 3',
  ]);
});

describe('② 只读命令点到远程共享路径，回落询问', () => {
  expectGated([
    // 设计稿与任务单点名的写法
    'dir \\\\fileserver\\team',
    'Get-Content \\\\fileserver\\team\\notes.txt',
    'Test-Path //fileserver/team/a.txt',
    'Get-ChildItem \\\\?\\UNC\\fileserver\\team',
    'Get-ChildItem \\\\.\\C:\\',
    'dir \\\\fileserver@SSL\\DavWWWRoot',
    'Get-ChildItem Microsoft.PowerShell.Core\\FileSystem::\\\\fileserver\\team',
    'Get-ChildItem FileSystem:://fileserver/team',
    // 路径记号前面是引号、等号、逗号
    'Get-Content "\\\\fileserver\\team\\a.txt"',
    "Get-Content '\\\\fileserver\\team\\a.txt'",
    'Get-Content a.txt,\\\\fileserver\\team\\b.txt',
    'rg --ignore-file=\\\\fileserver\\team\\ignore TODO src',
    // 混写的分隔符在 Windows 上同样是 UNC
    'Get-Content /\\fileserver\\team\\a.txt',
    'rg TODO \\\\fileserver\\team',
    'dir \\\\fileserver\\team | Select-Object Name',
    // 参数值紧贴参数名的几种写法：冒号绑定（PowerShell / findstr）、短旗标紧贴值（rg -f 从文件读模式）
    'Get-ChildItem -Path:\\\\fileserver\\team',
    'findstr /G:\\\\fileserver\\team\\patterns.txt notes.txt',
    'rg -f\\\\fileserver\\team\\patterns.txt src',
    // PowerShell 的拼接：空变量前缀、引号拼接（裸字开头的参数把紧挨着的引号串拼进来：\''\host 就是 \\host）、
    // 弯引号与长短横线（PowerShell 都认）
    'Get-Content $nothing\\\\fileserver\\team\\a.txt',
    "Get-Content \\''\\fileserver\\team\\a.txt",
    'Get-Content \\\u2018\u2019\\fileserver\\team\\a.txt',
    'Get-Content \u201c\\\\fileserver\\team\\a.txt\u201d',
    'Get-ChildItem \u2013Path:\\\\fileserver\\team',
    // 反过来，以引号开头的参数在收尾引号处就断开，后面紧跟的是另一个参数："a.txt"\\host 是 a.txt 与 \\host 两个路径
    'Get-Content "a.txt"\\\\fileserver\\team\\b.txt',
    'Get-Content \u201ca.txt\u201d\\\\fileserver\\team\\b.txt',
    // NT 前缀 \??\UNC\ 经原生程序直通到远程共享
    'rg TODO \\??\\UNC\\fileserver\\team',
  ]);
});

describe('③ 不带 $ 的 env: 提供程序路径，与 $env: 同理回落询问', () => {
  expectGated([
    'Get-ChildItem env:',
    'gci Env:\\',
    'Get-Content env:PATH',
    'dir env:',
    'ls ENV:/',
    'Get-Item -Path Env:OPENAI_API_KEY',
    'Get-ChildItem -Path:env:',
    'Get-ChildItem "env:"',
    'gci env: | Select-Object Name',
    // 提供程序限定写法与引号拼接（两种拼法见 ② 的注释），读到的是同一个环境变量驱动器
    'Get-ChildItem Environment::',
    'Get-Item Microsoft.PowerShell.Core\\Environment::PATH',
    "Get-ChildItem e''nv:",
    'Get-Content "a.txt"env:PATH',
  ]);
});

describe('补：带远程主机参数的只读命令，回落询问', () => {
  expectGated([
    // Windows PowerShell 5.1 的 Get-Process / Get-Service 带 -ComputerName（别名 -Cn，可写无歧义前缀）去问别的机器
    'Get-Process -ComputerName fileserver',
    'Get-Process \u2013ComputerName fileserver',
    'gps -cn fileserver',
    'ps -C fileserver',
    'Get-Service -ComputerName:fileserver',
    'Get-Service -Comp fileserver -Name spooler',
    // systeminfo /S <主机> 查远程计算机
    'systeminfo /s fileserver',
    'systeminfo -S fileserver /fo csv',
    // Get-Help -Online 打开浏览器访问帮助网址
    'Get-Help Get-Process -Online',
    'help about_Scopes -on',
  ]);
});

describe('补：引号拼接出的数据根字样同样回落（W1b-2 的规则按拼接后的文本认）', () => {
  expectGated([
    // PowerShell 把 Desk''Minis 拼成 DeskMinis
    "Get-ChildItem C:\\Users\\me\\AppData\\Roaming\\Desk''Minis",
  ]);
});

describe('放行对照：只读本地的命令照旧免询问', () => {
  it.each([
    'npm ls',
    'npm ls --depth=0',
    'npm config get registry',
    'git log --oneline -5',
    'git status',
    'Get-Content notes\\a.txt',
    'Get-Content .\\notes\\a.txt',
    'Get-ChildItem C:\\Users\\me\\Documents',
    // 盘符后的双反斜杠是本地路径（JSON 里转义过的写法常被原样抄来）
    'Get-Content C:\\\\Users\\\\me\\\\a.txt',
    // URL 里 scheme 之后的 :// 前面是单个冒号，搜这串字是在本地文件里找字面
    'rg "https://example.com" src',
    'rg https://example.com src',
    'git log --grep=https://example.com',
    // 两个斜杠后面没有主机名（空白、引号、到头）：搜代码注释不是路径
    'rg "// TODO" src',
    'rg "//" src',
    // 路径中段的双斜杠
    'Get-Content a//b.txt',
    // 字样里有 env 但不是 env: 驱动器（dotenv: 里的 env: 在词中间）
    'rg NODE_ENV src',
    'Get-Content .env.example',
    'rg "dotenv:" src',
    // 不带远程参数的同名命令
    'Get-Process',
    'Get-Process -Name code',
    'Get-Service -Name spooler',
    'systeminfo',
    'systeminfo /fo csv',
    'Get-Help Get-Process -Full',
    'Get-ChildItem $PWD',
  ])('%s → readonly，零询问', async (cmd) => {
    expect(classifyShellCommand(cmd)).toBe('readonly');
    expect(await askCount(cmd)).toEqual({ decision: 'allow', asked: 0 });
  });

  it('危险层照旧先行：删远程共享、清环境变量仍是 danger，不被降成 gated', () => {
    expect(classifyShellCommand('Remove-Item \\\\fileserver\\team\\a.txt')).toBe('danger');
    expect(classifyShellCommand('Remove-Item env:OPENAI_API_KEY')).toBe('danger');
  });
});

describe('完全访问档：回落后的 gated 跟随档位放行（与既有 gated 一致，不额外设卡）', () => {
  it.each([
    'npm view left-pad',
    'Get-Content \\\\fileserver\\team\\notes.txt',
    'Get-ChildItem env:',
  ])('%s → full 档零询问放行', async (cmd) => {
    let asked = 0;
    const gw = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    gw.applyPreset('full');
    expect(await gw.check(req(cmd))).toBe('allow');
    expect(asked).toBe(0);
  });
});
