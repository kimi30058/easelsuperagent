# UI 以 dsh 面板为主，弃 Easel Web 工作台

不迁移 Easel 的 Web 前后端（React 前端 + 5681 行 FastAPI 单体 web/app.py）；复用 dsh 面板的 Trigger/Ticket/Execution/Settings 页，自媒体专属界面（日历、发布中心、扫码登录）用 dsh-client-ui-slots 分期补。考虑过双 UI 并存（功能最全但两套 UI + 两套后端同时维护，5681 行单体继续背着）与纯 CLI（扫码登录、发布状态监控体验差）。个人自用场景下单一 dsh 面板的维护面最小。
