import {afterEach, describe, it, expect} from 'vitest';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {officeWriteTool} from '../src/minisd/tools/office';
import {readZip} from '../src/minisd/office/zip';
import {closeAllCpEnvs, cpEnv} from './checkpoint-fixture';

afterEach(closeAllCpEnvs);
describe('F10A stage2 missing behavior', () => {
  it('foreign Word images, header and comments cannot be lost by overwrite', async () => {
    const env=cpEnv('f10a-red-foreign'), sid=env.newSession();
    const original=readFileSync(join(__dirname,'fixtures/office/foreign-word.docx'));
    const path=join(env.userDir,'foreign.docx'); writeFileSync(path,original);
    const r=await officeWriteTool.execute({path,content:JSON.stringify({blocks:[{kind:'para',text:'replacement'}]}),tool_title:'创建文档'},env.ctx(sid));
    expect(r.success).toBe(false);
    expect(readFileSync(path)).toEqual(original);
    expect(env.rows()).toEqual([]);
  });
  it('successful Word output discloses content and layout verification', async () => {
    const env=cpEnv('f10a-red-verification'), sid=env.newSession();
    const path=join(env.userDir,'new.docx');
    const r=await officeWriteTool.execute({path,content:JSON.stringify({blocks:[{kind:'para',text:'中文'}]}),tool_title:'创建文档'},env.ctx(sid));
    expect(r.success,r.output).toBe(true);
    expect(r.output).toContain('内容核验：通过');
    expect(r.output).toContain('版式核验：未核验');
  });
  it('tool honors document title and landscape instead of dropping new fields', async () => {
    const env=cpEnv('f10a-red-fields'), sid=env.newSession();
    const path=join(env.userDir,'new.docx');
    const r=await officeWriteTool.execute({path,content:JSON.stringify({title:'最终报告',page:{orientation:'landscape'},blocks:[]}),tool_title:'创建文档'},env.ctx(sid));
    expect(r.success,r.output).toBe(true);
    const parts=await readZip(readFileSync(path));
    expect(parts.get('docProps/core.xml')?.toString()).toContain('最终报告');
    expect(parts.get('word/document.xml')?.toString()).toContain('w:orient="landscape"');
  });
});
