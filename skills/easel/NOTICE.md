# NOTICE — Easel 技能库归属与许可说明

本目录（`skills/easel/`，含 `builtin/` 与 `shared/`，共 115 个技能）来自开源项目 **[ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel)**（浙江大学 REAL Lab × 北京大学），依据 **Apache License 2.0** 集成，许可证原文见本目录 [LICENSE](LICENSE)，各技能的来源、作者与集成时间见其目录下的 `EASEL-META.md`，完整来源清单见 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)。

## 本仓库的修改

集成时保留上游目录结构与技能内容，未重写技能；挂载方式（worker 工作区经符号链接引用本目录）见仓库的 `scripts/prepare-ticket.sh`。若后续修改任何技能，请在对应 `EASEL-META.md` 中追加修改记录。

## 目录内嵌的第三方组件（各自许可优先于 Apache-2.0）

| 路径 | 来源 | 许可 |
|---|---|---|
| `builtin/gzh-design/` | [isjiamu/gzh-design-skill](https://github.com/isjiamu/gzh-design-skill)（整包 vendored） | **AGPL-3.0**，见目录内 `LICENSE`。修改后再分发须按 AGPL-3.0 提供源码；以网络服务形式提供亦触发其 §13 |
| `builtin/video-production/vendor/video-pipeline-sdk/` | [mengyuyuan/video-pipeline-sdk](https://github.com/mengyuyuan/video-pipeline-sdk) v0.3.5 | MIT，原文随包保留，修改与同步记录见 `builtin/video-production/vendor/VENDOR.md` |

## 未尽事项

上游 Easel 的来源清单中，部分技能的许可字段仍标注「待核实」（见 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)），其中 `skill-audience-profiler` 与 `skill-content-calendar` 为移植改编（可能构成衍生作品）。**商用或对外分发前，请先完成这些来源的协议核实**；上游后续的核实结果应以同步方式更新本目录。
