# EDU-07 schema-ready fixture repair

修复课堂与首页视频缩略图端到端夹具的真实 IndexedDB 就绪判定。原 fixture 使用 `page.waitForFunction(async () => ...)`；当前 Playwright 实现会把 async predicate 返回的 Promise 当作 truthy，因而在数据库仍为 version 100 时提前继续。旧探针从实际 `classroom-interaction.spec.ts` 提取原 `seedDatabase` 已复现该错误：错误版本仍写入 1 个 stage、3 个 scenes、1 个 outline；缺少 `stageOutlines` 才会被原 guard 拒绝。

修复内容：用带 5 秒上限的 `expect.poll` 等待 `page.evaluate` 的已解析结果；种子打开数据库后再次检查 version 110 和将写入的全部 object stores（视频夹具也检查 `mediaFiles`）；fixture transaction 仅在 `oncomplete` 后 resolve，所有同步写异常调用 `abort` 并以原异常 reject。新增独立 schema-probe helper 与四类 fixture self-tests：version 100 全表、version 110 缺表、正确 schema 事务完成、同步写失败全量回滚。probe 将页面路由到静态 HTTP 文档，保留 Chrome 原生 IndexedDB，避免应用自动迁移伪造正例。测试只验证夹具，不修改产品 schema 或迁移。

证据（工作区外由协调者保管）：两个仓库各 fixture self-test 8/8，0 skipped；旧代码同 harness 各 3 passed、5 failed（低版本意外写入及同步异常未及时拒绝）；生产构建 Chrome 原套件 HyperClass 30/30、OpenMAIC 23/23，`--retries=0 --workers=1`，0 flaky/skip。生产浏览器报告及 red/green 日志位于协调者 `work/edu07-evidence-2026-10-08/`。

剩余事项：独立复核、CI、合并和发行/真实服务观察由协调者执行。不要将此 fixture 证据解释为产品 schema migration 或生产发布证据。
