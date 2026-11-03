# 真发布由 worker 执行

批准后的真实发布由 worker（执行 Ticket 的 DSH Session）在 Ticket 目录运行平台技能脚本完成，sidecar 不 spawn 发布进程——与登录 runner（sidecar spawn，ADR-0007）刻意不对称。发布把关（ADR-0001）的授权载体是 operator 消息：worker 执行使批准、动作与报告留在同一条 Mandate 链路里，技能文档（抖音后台跑+状态文件+验证码文件的模式）本就是为 LLM 运行时预演的。sidecar 只加两个薄端点：读 `outputs/_publish/` 状态、回填短信验证码。备选的 sidecar 发布 runner（Easel Web 原模式）会把批准变成 UI 事件、打断授权归因，且需重建发布参数输入面，被否决。
