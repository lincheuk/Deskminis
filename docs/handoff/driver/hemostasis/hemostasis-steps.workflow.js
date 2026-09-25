export const meta = {
  name: 'hemostasis-steps',
  description: 'Run stop-the-bleeding steps: TDD implement + local commit, adversarial review, fix loop; chains run in parallel, steps within a chain run in order',
  phases: [
    { title: 'Implement', detail: 'one implementer per step, TDD, local commit (no push)' },
    { title: 'Review', detail: 'independent adversarial reviewer per step' },
    { title: 'Fix', detail: 'address must-fix findings, amend, re-review' },
  ],
}

const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad'
const DOCS = '/home/user/deskminis-docs/docs'
const DESIGN = `${DOCS}/specs/2026-09-24-hemostasis-design.md`
const APPX = `${DOCS}/specs/2026-09-24-hemostasis`

function common(chain, step) {
  const app = `${chain.dir}/deskminis`
  return `【项目】DeskMinis：Windows 桌面通用 Agent 应用（Electron + TS + Vue3 + Pinia + better-sqlite3；引擎 minisd 在 utilityProcess，经 WebSocket JSON-RPC 与渲染端通信）。
【你的工作目录】git 仓库根 ${chain.dir}（分支 ${chain.branch}），应用代码在 ${app}。只在这个目录里改代码与提交。每条 Bash 命令都要自带 cd 或用绝对路径（cwd 在调用之间会重置）。
【权威依据，必读】
1. 设计稿 ${DESIGN}（§1 纪律、§2 拍板落定、§3 统一契约、§4 步骤表）。与附录冲突时以设计稿为准。
2. 本步侦察计划：${APPX}/${step.scout}（找到条目 ${step.items}，含现状事实、改动点、先红测试、会翻红的守卫、风险）。
3. 步骤切分与冲突顺序：${APPX}/cross.md（找到 ${step.cross}）。
4. 项目纪律与验证工具箱：${DOCS}/handoff/2026-09-10-session-handoff.md 的 §2、§3（零新 npm 依赖；TDD 先红；DB 只追加迁移且本波不加迁移；注释用中文写「为什么」；源码守卫断言认调用形态不认裸字符串；UI 改动必 xvfb 目视）。
【本步】${step.id}：${step.title}
${step.notes ? '【补充要求】' + step.notes : ''}
【命令】
- 单测：cd ${app} && npx cross-env ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron node_modules/vitest/vitest.mjs run <文件…>
- 类型检查：cd ${app} && npm run typecheck > ${S}/hemo-logs/${step.id}-tc.log 2>&1; echo EXIT=$?
- 全量与基线比对：cd ${app} && npm test > ${S}/hemo-logs/${step.id}-full.log 2>&1; grep '^ FAIL ' ${S}/hemo-logs/${step.id}-full.log | sed 's/^ FAIL  //' | LC_ALL=C sort | diff ${DOCS}/handoff/linux-baseline-failures.txt - && echo BASELINE_DIFF_EMPTY
  （全量里 52 例 Windows-only 失败是基线；diff 必须为空。新增测试必须在 Linux 上能跑。）
- 界面实拍（仅界面改动）：cd ${app} && npm run build > ${S}/hemo-logs/${step.id}-build.log 2>&1; 剧本写在 ${S}/hemo-drivers/${step.id}-*.mjs，用 NODE_PATH=${S}/driver/node_modules xvfb-run -a node <剧本> 运行；剧本范例见 ${DOCS}/handoff/driver/（drive-z1.mjs、drive-y1.mjs、mock-openai.mjs）。截图存 ${S}/hemo-shots/${step.id}-*.png，并亲自用 Read 看图确认。数据根一律用 mkdtemp 临时目录，经 DESKMINIS_DATA_DIR 注入。
【注意】仓库根 THIRD-PARTY-NOTICES.md 有双向绊线（tests/license-consistency.test.ts 扫描 src 与 tests）：借用代码要在文件头写「改编自 <上游名>（<URL>）」并在对应上游节的表里追加一行；测试文件里不要写出字面的「改编自」三个字（会被当成登记标记），需要时换个说法。源码守卫（读 .vue/.ts 源码文本的测试）匹配前必须先剥掉注释（模板剥 <!-- -->，样式剥 /* */，脚本剥 /* */ 与 // 行），否则断言能被注释喂饱。全量里若出现疑似机器负载导致的超时失败，先单独重跑那个文件再下结论。
【禁止】npm install / npm ci / 改 dependencies；git push；改写本步之前的提交；修改 ${chain.dir} 之外的代码（${S} 下的日志、剧本、截图除外）；跳过或禁用测试。`
}

const COMMIT_RULES = (step) => `【提交】全部验证通过后，在本地提交一次（不要 push）：
- 提交信息写进 UTF-8 文件 ${S}/hemo-logs/${step.id}-msg.txt，用 git -c user.name="lincheuk" -c user.email="linchaoheng3@gmail.com" commit -F <文件> 提交。
- 标题行：「${step.id}: <一句中文简述>」。
- 正文分节写：做了什么；为什么（引用报告 §4 或设计稿条目）；先红（红测名称与红输出要点）；验证（typecheck 退出码、全量「N 文件 / M 例，失败 52 例，基线 diff 空」）；有意翻红的守卫（文件:行 · 原断言 · 新断言 · 理由）；偏差申报；自己判错又改回的。
- 正文最后两行必须原样是：
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Q9SVU7bhNjwanhMouUGF5`

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    commit: { type: 'string', description: '本步提交的完整 hash；未提交写 none' },
    summary: { type: 'string' },
    red_evidence: { type: 'string', description: '先红测试名与红输出要点；非先红的说明原因' },
    tests_added: { type: 'array', items: { type: 'string' } },
    guards_changed: { type: 'array', items: { type: 'string' } },
    typecheck_exit: { type: 'integer' },
    full_suite: { type: 'string', description: '例如「172 文件 / 1950 例，失败 52，基线 diff 空」' },
    baseline_diff_empty: { type: 'boolean' },
    xvfb_shots: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'array', items: { type: 'string' } },
    open_issues: { type: 'array', items: { type: 'string' }, description: '没解决、需要主会话决定的问题' },
  },
  required: ['id', 'commit', 'summary', 'red_evidence', 'tests_added', 'guards_changed', 'typecheck_exit', 'full_suite', 'baseline_diff_empty', 'xvfb_shots', 'deviations', 'open_issues'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'fix'] },
    must_fix: { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['issue', 'evidence', 'fix'] } },
    nits: { type: 'array', items: { type: 'string' } },
    checked: { type: 'array', items: { type: 'string' }, description: '你实际核对过的东西（跑了哪些测试、读了哪些文件）' },
  },
  required: ['verdict', 'must_fix', 'nits', 'checked'],
}

async function runStep(chain, step) {
  const base = common(chain, step)
  let rep
  if (step.reviewOnly) {
    // 已提交但未审查的步骤（例如容器重启打断了审查）：实现者报告已丢失，以提交正文为准
    rep = { id: step.id, commit: step.commit, summary: '实现者报告因容器重启丢失，请以 git show 的提交正文为准' }
  } else rep = await agent(`${base}

你是本步的实现者。按 TDD：先写失败测试并跑出红（红输出存 ${S}/hemo-logs/${step.id}-red.log），再实现，再做全部验证，最后提交。
开始前确认 git status 干净、HEAD 是上一步的提交（git -C ${chain.dir} log --oneline -3）。
${COMMIT_RULES(step)}
最后按 schema 返回报告。`, { label: `impl:${step.id}`, phase: 'Implement', schema: REPORT_SCHEMA })
  if (!rep) return { id: step.id, status: 'impl-failed' }
  let reviews = []
  for (let round = 1; round <= 3; round++) {
    const rv = await agent(`${base}

你是本步的独立审查者，实现者刚提交了 HEAD（${rep.commit}）。对抗式复核：假定它有错，去找。
- git -C ${chain.dir} show --stat HEAD 与 git -C ${chain.dir} show HEAD 通读 diff。
- 对照设计稿 §2/§3 与侦察计划，核对行为是否完整、契约字段名是否一致、边界情况（空值、Windows 路径、并发、取消）是否处理。
- 核对纪律：没有新依赖；新守卫断言认调用形态、不会被注释喂饱；有意翻红的守卫在提交正文里逐条申报；借用代码已在 THIRD-PARTY-NOTICES 登记；没有 DB 迁移；注释写「为什么」。
- 亲自跑本步新增与改动的测试文件，并跑 typecheck；有疑点就写小实验验证（放在 ${S}/hemo-logs/ 下，不要改仓库）。
- 界面改动：看 ${S}/hemo-shots/${step.id}-*.png 是否真的证明了改动。
只把「会导致错误行为、数据损坏、测试漏网或违反纪律」的问题列进 must_fix（守卫能被注释或散文喂饱属于测试漏网，必须列进 must_fix）；风格建议放 nits。源码守卫只防现实中会发生的回退（注释或散文喂饱、自然的重构写法：改用 watch、换个函数名、挪进帮手文件或别的目录）；刻意混淆的写法（HTML 实体或转义拼标识符、arguments 反射、非 ASCII 同义标识符、经高阶调用转手函数、字符串拼属性名）不算测试漏网，只放 nits（设计稿 §1 第 8 条）。不要修改仓库。
实现者报告：${JSON.stringify(rep)}`, { label: `review:${step.id}#${round}`, phase: 'Review', schema: REVIEW_SCHEMA })
    if (!rv) break
    reviews.push(rv)
    if (rv.verdict === 'approve' || rv.must_fix.length === 0) break
    if (round === 3) break
    const fixed = await agent(`${base}

你是本步的修正者。审查者对 HEAD（${rep.commit}）提出了必须修的问题：
${JSON.stringify(rv.must_fix)}
逐条修正（若你确信某条不成立，写明证据并在提交正文「审查意见处置」一节说明不修的理由）。修完重跑本步测试、typecheck、全量与基线比对。
然后用 git commit --amend -F 更新同一个提交（这是尚未推送的本地提交），提交正文追加「审查意见处置」一节。
${COMMIT_RULES(step)}
最后按 schema 返回报告（commit 写 amend 后的新 hash）。`, { label: `fix:${step.id}#${round}`, phase: 'Fix', schema: REPORT_SCHEMA })
    if (fixed) rep = fixed
  }
  const last = reviews[reviews.length - 1]
  return { id: step.id, status: last && (last.verdict === 'approve' || last.must_fix.length === 0) ? 'approved' : 'unresolved', report: rep, reviews }
}

async function runChain(chain) {
  const out = []
  for (const step of chain.steps) {
    log(`${chain.name}: start ${step.id}`)
    const r = await runStep(chain, step)
    out.push(r)
    log(`${chain.name}: ${step.id} ${r.status}`)
    if (r.status === 'impl-failed') break
  }
  return { chain: chain.name, results: out }
}

const results = await parallel(args.chains.map(c => () => runChain(c)))
return results
