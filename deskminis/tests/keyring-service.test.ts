/** W1a-9：keyring 服务名可注入（src/minisd/store/provider-store.ts 的 KeyringVault 与 keyringServiceFromEnv）。
 *
 *  以前服务名写死 'DeskMinis'，dev 与正式版共用 provider:<id>、search-provider、pairing.static-identity 这些槽：
 *  同一个设备指纹、搜索 key 互相覆盖。现在主进程经 DESKMINIS_KEYRING_SERVICE 下发（dev 为 'DeskMinis-dev'），
 *  minisd 用 `new KeyringVault(keyringServiceFromEnv(process.env))`；缺省或空白仍是 'DeskMinis'，
 *  这样不经主进程起的 standalone 脚本（e2e-acceptance 等）照旧读正式版的 key。
 *
 *  entry() 是懒加载的，构造 KeyringVault 不碰原生模块；这里不调 get/set，免得碰到真实凭据库。
 *  entry() 的形态只能看源码：读进来先去注释，免得回退后留在注释里的旧调用原文喂饱正向断言。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyringVault, keyringServiceFromEnv } from '../src/minisd/store/provider-store';
import { stripComments } from './strip-comments';

const providerStore = stripComments(
  readFileSync(join(__dirname, '..', 'src/minisd/store/provider-store.ts'), 'utf8').replace(/\r\n/g, '\n'),
);

describe('KeyringVault 的服务名', () => {
  it('缺省是 DeskMinis（正式版已存的 key 都在这个服务名下，不能变）', () => {
    expect(new KeyringVault().service).toBe('DeskMinis');
  });

  it('可以注入 DeskMinis-dev', () => {
    expect(new KeyringVault('DeskMinis-dev').service).toBe('DeskMinis-dev');
  });

  it('entry() 用的是注入的服务名，不再写死字面量（认调用形态）', () => {
    expect(providerStore).toMatch(/return new Entry\(\s*this\.service\s*,\s*key\s*\);/);
    // 只有这一处构造：死代码里留一句 new Entry(this.service, key) 喂不饱上一条
    expect(providerStore.match(/new Entry\(/g) ?? [], 'Entry 只在 entry() 里构造').toHaveLength(1);
    expect(providerStore).not.toMatch(/new Entry\(\s*['"]DeskMinis['"]/);
  });
});

describe('keyringServiceFromEnv', () => {
  it('没设就是 DeskMinis', () => {
    expect(keyringServiceFromEnv({})).toBe('DeskMinis');
  });

  it('空串或纯空白也当没设', () => {
    expect(keyringServiceFromEnv({ DESKMINIS_KEYRING_SERVICE: '' })).toBe('DeskMinis');
    expect(keyringServiceFromEnv({ DESKMINIS_KEYRING_SERVICE: '   ' })).toBe('DeskMinis');
  });

  it('设了就用它（去掉首尾空白）', () => {
    expect(keyringServiceFromEnv({ DESKMINIS_KEYRING_SERVICE: 'DeskMinis-dev' })).toBe('DeskMinis-dev');
    expect(keyringServiceFromEnv({ DESKMINIS_KEYRING_SERVICE: ' DeskMinis-dev \n' })).toBe('DeskMinis-dev');
  });
});
