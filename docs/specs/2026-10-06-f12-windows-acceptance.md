# F12 Windows 最终验收设计

基线为已合入F10C的04dc936a397467df98c623f4f666b94dba4f2775。所有既有models.dev和16项核心修复保持，不重复应用；当前代理复核，缺少独立性。一个F12本地提交，包含可重复验收入口、安装验收保护和必要行为用例。无推送、Release、上传、真实API费用或正式数据改动。

环境：先在新隔离目录复制原package/lock，以官方npm10.9.4和Node24.19执行npm ci、原生Electron38.8.6 ABI139重建，保存命令/退出码/完整原文/锁SHA。不对主检出node_modules联接执行ci或递归删除。锁文件不能自动升级；干净安装失败记真实阻塞，不用既有pnpm依赖伪称可复现。既有依赖仍可独立完成源码、目录包和实际行为验收。

验收入口逐步记录Git源码SHA/dirty、Windows/Node/Electron/native ABI、package与lock摘要、每步命令/起止/退出码、日志、产物摘要和scope。执行全量、tsc/build、目录/NSIS/portable本地构建、release文件一致检查、打包态worker/取消/主循环响应、定时任务新增编辑清空重开、联网权限路径、退出/进程回收、Office文件与重载。真实UI截图由computer-use逐步观察；API/进程/文件证据与截图分开，mock模型标明回环假端点。

安装器验收必须先确定无现有用户安装和同身份进程/登记；查不到、权限不足或有现有安装时立即阻止，不自动卸载已有应用。卸载本次临时安装前必须重新核对登记路径为本次预期目录；路径改变则不执行卸载。保留真实失败和可恢复目录；没有通过收尾不能写PASS。旧版本覆盖升级只用可获取且本次自建的隔离样本，不伪称验证了用户历史0.1.1。

实际应用使用临时DESKMINIS_DATA_DIR、--user-data-dir和DESKMINIS_E2E文件凭据库；不用正式%APPDATA%或用户keyring。固定样本产生的配对身份/token只用于进程内，不进补丁和公开报告。退出只动握持的测试进程对象/句柄；不按映像名结束进程。

只有一台Windows，无服务商key：双真实设备/付费真实API明确未验证，不用本地两实例mock填真实PASS。最终报告分开可执行的验收结果与发布未核验项；不具备完整发布证据时结论证据不足，不宣称可发布。

首轮真实NSIS发现：npm在node_modules目录联接下把dev依赖误纳入并产生缺版本引用，导致keyring原生模块漏包；实体npm-ci目录依赖树正常。因此包构建复制审核源码的out/resources及锁定实体依赖到全新实体目录，按原electron-builder配置/标准npm收集器打包，不改packageManager元数据。每步cwd/原始树/实体阶段输入摘要留证。NSIS的Uninstall登记不写InstallLocation，必须同时核对安装位置登记与UninstallString中绝对卸载程序路径；拒绝不明或变更路径，卸载后复查所有hive/view与同名进程。探针读取ASAR字节用Electron原始fs，CLI超时留出夹具自行收尾时间。
