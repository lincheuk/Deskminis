/** F10A · T9：Office 核验结果的类型与纯函数（三个 Office 任务共用的契约）。
 *
 *  要钉住的是「没有经真实程序的就不能说成通过」：构造函数的不变量、固定措辞、运行器记录到结论的映射。
 *  只测类型与纯函数；这些用例证明不了任何一份文档的版式。工具级的输出断言在 office-write-flow（接线之后）。 */
import { describe, it, expect } from 'vitest';
import {
  officeVerified, officeFailed, officeUnverified, officeVerificationLine, isLayoutVerified, isOfficeVerification,
  isOfficeRunnerEnvelope, officeVerificationFromRun,
  type OfficeCheckItem, type OfficeEngine, type OfficeRunnerEnvelope, type OfficeRunnerOutcome, type OfficeUnverifiedReason, type OfficeVerification,
} from '../src/shared/office-verification';

const SUBJECT = { sha256: 'a'.repeat(64), size: 1234 };
const READBACK: OfficeEngine = { id: 'deskminis-readback', version: '1' };
const WORD: OfficeEngine = { id: 'ms-word', version: '16.0.15128' };
const OK: OfficeCheckItem[] = [{ id: 'parts', ok: true }, { id: 'xml', ok: true }];
const CONTENT_OK = '生成文件回读与本次输入的 3 项一致；不涉及版式，也不代表与其它文档一致';

function envelope(over: Partial<OfficeRunnerEnvelope<{ n: number }>> = {}): OfficeRunnerEnvelope<{ n: number }> {
  return {
    schema: 1, app: 'word', input: SUBJECT, outcome: 'measured', stage: 'done', detail: 'pages=1', engine: WORD,
    env: { launch: 'safe-exe', seconds: 6.5, locked: true, preexistingPids: [], killedPids: [4321], leftRunning: [], visibleWindows: [] },
    measured: { n: 1 },
    ...over,
  };
}
const judgeOk = (): OfficeCheckItem[] => [{ id: 'compat-mode', ok: true }, { id: 'paper', ok: true }];

describe('T9 构造函数的不变量', () => {
  it('verified：带不过的项、没有任何项、没量到的项 → 抛', () => {
    expect(() => officeVerified('content', SUBJECT, READBACK, [{ id: 'xml', ok: false }], 'm')).toThrow(/没有通过/);
    expect(() => officeVerified('content', SUBJECT, READBACK, [], 'm')).toThrow(/没有任何检查项/);
    expect(() => officeVerified('layout', SUBJECT, WORD, [{ id: 'fonts-pdf', ok: false, unmeasured: true }], 'm')).toThrow();
  });

  it('内置回读给不出版式或计算结论：layout / calc 配 deskminis-readback 的 verified 与 failed 都构造不出来', () => {
    expect(() => officeVerified('layout', SUBJECT, READBACK, OK, 'm')).toThrow(/内置回读不能给出版式核验的结论/);
    expect(() => officeVerified('calc', SUBJECT, READBACK, OK, 'm')).toThrow(/计算核验/);
    expect(() => officeFailed('layout', SUBJECT, READBACK, [{ id: 'x', ok: false }])).toThrow(/内置回读/);
    // 内容核验配内置回读是正路
    expect(officeVerified('content', SUBJECT, READBACK, OK, CONTENT_OK).status).toBe('verified');
  });

  it('failed：没有「量到了且不过」的项 → 抛；failed 列表不含没量到的项；message 缺省取首个不过的项', () => {
    expect(() => officeFailed('layout', SUBJECT, WORD, OK)).toThrow(/没有量到了且不过的项/);
    expect(() => officeFailed('layout', SUBJECT, WORD, [{ id: 'fonts-pdf', ok: false, unmeasured: true }])).toThrow(/没有量到了且不过的项/);
    const v = officeFailed('layout', SUBJECT, WORD, [
      { id: 'compat-mode', ok: true }, { id: 'fonts-pdf', ok: false, unmeasured: true },
      { id: 'margins', ok: false, where: '左边距', expected: '90 磅', actual: '30 磅' }, { id: 'paper', ok: false },
    ]);
    expect(v.status === 'failed' && v.failed).toEqual(['margins', 'paper']);
    expect(v.message).toBe('margins（左边距）：应为 90 磅，实际 30 磅');
  });

  it('没量到的项不能记成通过：三个构造函数都查', () => {
    const bad = [{ id: 'fonts-pdf', ok: true, unmeasured: true as const }];
    expect(() => officeVerified('layout', SUBJECT, WORD, bad, 'm')).toThrow(/没量到的项不能记成通过/);
    expect(() => officeFailed('layout', SUBJECT, WORD, [...bad, { id: 'x', ok: false }])).toThrow(/没量到的项不能记成通过/);
    expect(() => officeUnverified('layout', SUBJECT, 'incomplete', 'm', WORD, bad)).toThrow(/没量到的项不能记成通过/);
  });
});

describe('T9 工具输出里的固定措辞', () => {
  it('内容核验通过的一行：带「与本次输入」「不涉及版式，也不代表与其它文档一致」两处限定，不带版本号', () => {
    const line = officeVerificationLine(officeVerified('content', SUBJECT, READBACK, OK, CONTENT_OK));
    expect(line).toBe(`内容核验：通过（deskminis-readback；${CONTENT_OK}）`);
    expect(line).toContain('与本次输入');
    expect(line).toContain('不涉及版式，也不代表与其它文档一致');
  });

  it('措辞表逐行', () => {
    expect(officeVerificationLine(officeFailed('content', SUBJECT, READBACK, [{ id: 'xml', ok: false }], '部件不是良构的 XML')))
      .toBe('内容核验：未通过（deskminis-readback）——部件不是良构的 XML');
    expect(officeVerificationLine(officeVerified('layout', SUBJECT, WORD, OK, '3 页')))
      .toBe('版式核验：通过（ms-word 16.0.15128；3 页）');
    expect(officeVerificationLine(officeFailed('layout', SUBJECT, WORD, [{ id: 'margins', ok: false }], '左边距不符')))
      .toBe('版式核验：未通过（ms-word 16.0.15128）——左边距不符');
    expect(officeVerificationLine(officeVerified('calc', SUBJECT, { id: 'ms-excel', version: '16.0.15128' }, OK, '公式已重算')))
      .toBe('计算核验：通过（ms-excel 16.0.15128；公式已重算）');
    expect(officeVerificationLine(officeUnverified('layout', SUBJECT, 'not-run', '本版本不在运行时启动 Word')))
      .toBe('版式核验：未核验——本版本不在运行时启动 Word');
    expect(officeVerificationLine(officeUnverified('content', SUBJECT, 'not-implemented', '这种格式还没有接入内容核验')))
      .toBe('内容核验：未核验——这种格式还没有接入内容核验');
  });

  it('所有未核验原因的行都含「未核验」、都不含「通过」', () => {
    const reasons: OfficeUnverifiedReason[] = ['not-run', 'not-implemented', 'engine-missing', 'engine-busy', 'session-locked', 'runner-busy',
      'incomplete', 'timeout', 'blocked-dialog', 'engine-error', 'cancelled', 'denied'];
    for (const reason of reasons) {
      for (const aspect of ['content', 'layout', 'calc'] as const) {
        const line = officeVerificationLine(officeUnverified(aspect, SUBJECT, reason, '说明文字', WORD));
        expect(line).toContain('未核验');
        expect(line).not.toContain('通过');
      }
    }
  });

  it('isLayoutVerified 只认版式一项的 verified：内容通过、版式未核验、版式未通过都不算', () => {
    const content = officeVerified('content', SUBJECT, READBACK, OK, CONTENT_OK);
    const notRun = officeUnverified('layout', SUBJECT, 'not-run', 'm');
    const failed = officeFailed('layout', SUBJECT, WORD, [{ id: 'x', ok: false }]);
    expect(isLayoutVerified([content, notRun])).toBe(false);
    expect(isLayoutVerified([content, failed])).toBe(false);
    expect(isLayoutVerified([])).toBe(false);
    expect(isLayoutVerified([content, officeVerified('layout', SUBJECT, WORD, OK, 'm')])).toBe(true);
  });
});

describe('T9 读外来的记录时校验（isOfficeVerification / isOfficeRunnerEnvelope）', () => {
  it('构造函数造出来的都认', () => {
    const all: OfficeVerification[] = [
      officeVerified('content', SUBJECT, READBACK, OK, CONTENT_OK),
      officeFailed('layout', SUBJECT, WORD, [{ id: 'x', ok: false }, { id: 'y', ok: false, unmeasured: true }]),
      officeUnverified('layout', SUBJECT, 'incomplete', 'm', WORD, [{ id: 'y', ok: false, unmeasured: true }]),
      officeUnverified('layout', SUBJECT, 'not-run', 'm'),
    ];
    for (const v of all) expect(isOfficeVerification(JSON.parse(JSON.stringify(v)))).toBe(true);
  });

  it('伪造的不认：缺引擎的 verified、带不过项的 verified、内置回读的版式结论、failed 列表对不上、未知原因', () => {
    const good = JSON.parse(JSON.stringify(officeVerified('layout', SUBJECT, WORD, OK, 'm'))) as Record<string, unknown>;
    expect(isOfficeVerification({ ...good, engine: undefined })).toBe(false);
    expect(isOfficeVerification({ ...good, checks: [{ id: 'x', ok: false }] })).toBe(false);
    expect(isOfficeVerification({ ...good, checks: [] })).toBe(false);
    expect(isOfficeVerification({ ...good, engine: READBACK })).toBe(false);
    expect(isOfficeVerification({ ...good, subject: { sha256: 'short', size: 1 } })).toBe(false);
    expect(isOfficeVerification({ ...good, status: 'failed', failed: [] })).toBe(false);
    expect(isOfficeVerification({ ...good, status: 'failed', checks: [{ id: 'x', ok: false }], failed: ['y'] })).toBe(false);
    expect(isOfficeVerification({ ...good, status: 'unverified', reason: 'because' })).toBe(false);
    expect(isOfficeVerification({ ...good, checks: [{ id: 'x', ok: true, unmeasured: true }] })).toBe(false);
    expect(isOfficeVerification(null)).toBe(false);
    expect(isOfficeVerification('verified')).toBe(false);
  });

  it('运行器记录：形状对的认，缺字段或取值不在枚举里的不认', () => {
    expect(isOfficeRunnerEnvelope(JSON.parse(JSON.stringify(envelope())))).toBe(true);
    expect(isOfficeRunnerEnvelope({ ...envelope(), schema: 2 })).toBe(false);
    expect(isOfficeRunnerEnvelope({ ...envelope(), outcome: 'passed' })).toBe(false);
    expect(isOfficeRunnerEnvelope({ ...envelope(), stage: 'somewhere' })).toBe(false);
    expect(isOfficeRunnerEnvelope({ ...envelope(), input: { sha256: 'x', size: 1 } })).toBe(false);
    expect(isOfficeRunnerEnvelope({ ...envelope(), engine: { id: 'libreoffice', version: '7' } })).toBe(false);
    expect(isOfficeRunnerEnvelope({ ...envelope(), env: { ...envelope().env, killedPids: undefined } })).toBe(false);
    expect(isOfficeRunnerEnvelope({ ...envelope(), openError: { hresult: '0x800A1401', message: 'm', control: 'maybe' } })).toBe(false);
    expect(isOfficeRunnerEnvelope(undefined)).toBe(false);
  });
});

describe('T9 运行器记录 → 核验结论（officeVerificationFromRun）', () => {
  const run = (env: OfficeRunnerEnvelope<{ n: number }>, judge: (m: { n: number }) => OfficeCheckItem[] = judgeOk): OfficeVerification =>
    officeVerificationFromRun(env, 'layout', judge, m => `${m.n} 页`);

  it('measured 且每项都量到都过 → verified，绑定被打开的那份字节与引擎版本', () => {
    const v = run(envelope());
    expect(v).toMatchObject({ aspect: 'layout', status: 'verified', subject: SUBJECT, engine: WORD, message: '1 页' });
    expect(officeVerificationLine(v)).toBe('版式核验：通过（ms-word 16.0.15128；1 页）');
  });

  it('measured 且有量到了不过的项 → failed；同时有没量到的项时 failed 里不含它，message 里另注明', () => {
    const v = run(envelope(), () => [{ id: 'paper', ok: true }, { id: 'margins', ok: false, where: '左边距', expected: '90 磅', actual: '30 磅' }]);
    expect(v.status).toBe('failed');
    expect(v.status === 'failed' && v.failed).toEqual(['margins']);
    const mixed = run(envelope(), () => [{ id: 'margins', ok: false }, { id: 'fonts-pdf', ok: false, unmeasured: true }]);
    expect(mixed.status === 'failed' && mixed.failed).toEqual(['margins']);
    expect(mixed.message).toContain('另有没量到的项：fonts-pdf');
  });

  it('measured 但有项没量到、又没有真实不过的项 → unverified / incomplete，点名是哪几项，不说成未通过', () => {
    const v = run(envelope(), () => [{ id: 'paper', ok: true }, { id: 'fonts-pdf', ok: false, unmeasured: true }, { id: 'text-rendered', ok: false, unmeasured: true }]);
    expect(v).toMatchObject({ status: 'unverified', reason: 'incomplete' });
    expect(v.message).toContain('fonts-pdf');
    expect(v.message).toContain('text-rendered');
    expect(v.checks).toHaveLength(3);
    expect(officeVerificationLine(v)).toMatch(/^版式核验：未核验——/);
  });

  it('判定函数一项都没返回 → unverified / incomplete；判定函数抛错 → unverified / engine-error', () => {
    expect(run(envelope(), () => [])).toMatchObject({ status: 'unverified', reason: 'incomplete' });
    const thrown = run(envelope(), () => { throw new Error('量测里缺字段'); });
    expect(thrown).toMatchObject({ status: 'unverified', reason: 'engine-error' });
    expect(thrown.message).toContain('量测里缺字段');
  });

  it('判定函数把没量到的项错记成通过：按没量到处理，不会混成 verified', () => {
    const v = run(envelope(), () => [{ id: 'paper', ok: true }, { id: 'fonts-pdf', ok: true, unmeasured: true }]);
    expect(v).toMatchObject({ status: 'unverified', reason: 'incomplete' });
  });

  it('六种跑不起来的结局 → unverified，原因同名', () => {
    const cases: [OfficeRunnerOutcome, OfficeUnverifiedReason][] = [
      ['engine-missing', 'engine-missing'], ['engine-busy', 'engine-busy'], ['session-locked', 'session-locked'],
      ['runner-busy', 'runner-busy'], ['timeout', 'timeout'], ['blocked-dialog', 'blocked-dialog'],
    ];
    for (const [outcome, reason] of cases) {
      const v = run(envelope({ outcome, stage: 'precheck', measured: undefined, engine: undefined, detail: '说明' }));
      expect(v).toMatchObject({ status: 'unverified', reason });
    }
  });

  it('open-failed：同一个实例打得开对照文档才算文件的问题 → failed，唯一一项 open', () => {
    const v = run(envelope({ outcome: 'open-failed', stage: 'open', measured: undefined, detail: 'Documents.Open: 0x800A1401',
      openError: { hresult: '0x800A1401', message: 'Word 在试图打开文件时遇到错误', control: 'opened' } }));
    expect(v.status).toBe('failed');
    expect(v.status === 'failed' && v.failed).toEqual(['open']);
    expect(v.message).toContain('0x800A1401');
    expect(officeVerificationLine(v)).toMatch(/^版式核验：未通过（ms-word 16\.0\.15128）——/);
  });

  it('open-failed 但对照文档也打不开 / 没有试 / 没带 openError → unverified / engine-error，不记到文件头上', () => {
    for (const control of ['failed', 'not-run'] as const) {
      const v = run(envelope({ outcome: 'open-failed', stage: 'open', measured: undefined, detail: 'Documents.Open: 0x800706BE',
        openError: { hresult: '0x800706BE', message: 'RPC', control } }));
      expect(v).toMatchObject({ status: 'unverified', reason: 'engine-error' });
      expect(v.message).toContain('0x800706BE');
    }
    expect(run(envelope({ outcome: 'open-failed', stage: 'open', measured: undefined }))).toMatchObject({ status: 'unverified', reason: 'engine-error' });
    // 打得开对照文档但记录里没有引擎：同样不够格记成未通过
    expect(run(envelope({ outcome: 'open-failed', stage: 'open', measured: undefined, engine: undefined,
      openError: { hresult: '0x800A1401', message: 'm', control: 'opened' } }))).toMatchObject({ status: 'unverified', reason: 'engine-error' });
  });

  it('error，以及 measured 却缺引擎或缺量测 → unverified / engine-error', () => {
    expect(run(envelope({ outcome: 'error', stage: 'measure', measured: undefined, detail: 'stage=measure 0x800706BA' }))).toMatchObject({ status: 'unverified', reason: 'engine-error' });
    expect(run(envelope({ engine: undefined }))).toMatchObject({ status: 'unverified', reason: 'engine-error' });
    expect(run(envelope({ measured: undefined }))).toMatchObject({ status: 'unverified', reason: 'engine-error' });
  });

  it('任何结局都拼不出内置回读的版式结论', () => {
    const fake = envelope({ engine: READBACK });
    expect(() => run(fake)).toThrow(/内置回读/);
  });
});
