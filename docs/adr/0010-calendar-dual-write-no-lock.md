# 日历双写不加跨进程锁，接受 last-write-wins

`outputs/_schedule.json` 有两个写者：worker 侧技能经 `calendar_ops.py`（Ticket 排期/发布记录写）、console sidecar（日历增强的 CRUD）。原版 Easel Web 的 `_SCHEDULE_LOCK` 是进程内锁，跨进程不成立；sidecar 选择直写而非 spawn 脚本，是因为脚本只有 add/record-publish 子命令（无 update/delete）且 ADR-0002 禁改技能脚本。两端各自 tmp+replace 原子写，冲突窗口只是毫秒级 read-modify-write；个人自用、单运营者、低频写，接受 last-write-wins，不发明锁协议。若未来出现真实丢写，再收敛写路径（如全部经 sidecar）。
