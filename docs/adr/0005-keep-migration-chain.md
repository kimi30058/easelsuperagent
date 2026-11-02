# 保留 SQLite 迁移链，不截断 GitHub 历史迁移

设计 spec 曾计划截断迁移链到当前 schema。实现评估：迁移是连续版本序列，删除中间步骤会断链且需重写全部迁移为单步，风险大于收益。新库直接跑到最新 schema，GitHub 相关表与 KV 键成为空壳/死键（migration.ts 的 DEAD_KEYS 已列），无运行时副作用。KV.github 族与 Retry 类型保留在 kv.ts 仅供迁移读取。
