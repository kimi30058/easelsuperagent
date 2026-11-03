# 控制台页面布局以 Easel 原生 Web 为结构基准

2026-11-03 全页面重构会话定案：console（及共享的 `dt-*` 视图）的**布局结构**——页头带、三段式账号卡片、区块白卡、统计块、卡片行列表——以 Easel 原生 Web（`~/easel/web/frontend`）为对照基准；**视觉 token**（颜色、字体、圆角、间距）仍受 `design-system/easel-console/MASTER.md` 约束，不跟随 Easel 的近黑主按钮、暖纸 radial 背景与 Manrope webfont。理由：MASTER.md 刚定稿且其离线约束（零外联字体）与成对明暗 token 有据；用户痛点在层次与字段排布，不在配色。曾考虑全盘 Easel 化，因需推翻 MASTER.md 并放弃离线约束而否决。
