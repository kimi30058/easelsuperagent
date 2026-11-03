# 平台登录产物走 executionRoot/outputs/_login 文件协议，sidecar 全显式传参

技能脚本用 `Path(__file__).resolve().parents[3]` 定位项目根，fork 的技能库比 Easel 原仓库深一层（skills/easel/shared/scripts），默认路径全部错位；ADR-0002 又锁定脚本零修改。因此 sidecar（及后续 SP3 的 worker）调用登录/发布脚本时，一律显式传 `--qr-out/--status-file/--cookie/--sms-code-file` 等路径参数，登录产物统一落 `<executionRoot>/outputs/_login/`（状态 JSON、二维码 PNG、一次性验证码、日志、pid、biliup cookie）。选「改脚本适配新目录深度」被 ADR-0002 否决；「保留 Easel 的项目根默认路径」在 fork 目录结构下不可行。该目录布局即 SP3/SP4 读取登录态的契约。
