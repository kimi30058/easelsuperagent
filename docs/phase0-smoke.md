# Phase 0 冒烟清单

Phase 0 的验收链路：飞书发起 → 生产 → 发布闸门 → 确认 → 归档 → 回执。逐项人工过一遍；每步有「预期」与「失败时看哪里」。

前置：宿主已启动（`scripts/easel-superagent` 或 DSH profile），飞书 Source 已配置且 `allowed` 含运营者，`eval.mode=auto`，Execution 设置的 `prepare` 指向 `scripts/prepare-ticket.sh`，执行根放好共享 `.env`，本机有 python3 与 ffmpeg。

1. **发起**：飞书群里 @机器人：「帮我写一篇关于〈主题〉的 300 字短文」。
   预期：机器人回执收到；面板「执行」页出现新工单，worker Session 建立，Ticket 目录下有 `skills` 链接、`outputs/`、`profiles`、`.env`。
   失败时看：面板「来源」页 Source 健康；Ticket 若为 failed，看原因里的 prepare 输出（缺 python3/ffmpeg 会写明）。
2. **生产**：worker 用技能产出文稿到 `outputs/<主题>/`。
   预期：面板工单出现 progress 报告；产物文件存在。
   失败时看：worker Session 的输出（面板打开 Session）；技能脚本的 stderr 在报告里。
3. **闸门**：内容就绪后 worker 报 blocked。
   预期：飞书原对话收到「内容已就绪…回复『发布』或给修改意见」；工单进入 waitsForPerson（面板可见待答问题）。
   失败时看：worker 是否按手册报告（提示词 runtime/worker 的五条门）。
4. **修改意见（可选）**：回复一句修改意见。
   预期：worker 收到并修改，再次报 blocked 二次审批。
5. **确认**：回复「确认」。
   预期：worker 把产物归档并写入日历（执行根 `outputs/_schedule.json` 出现记录），随后报 ready，工单结束为 completed，飞书收到完成回执（含交付物路径）。
   失败时看：工单是否停在 waitsForPerson（说明回复没进原对话）；ready 后无回执看 relay（`~/.easel-superagent` 日志）。
6. **日历**：检查 `_schedule.json` 的记录与产物清单一致。
