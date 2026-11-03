# easel · 纸面工作台 —— UI 规范（MASTER）

唯一视觉规范源。面板（`src/client/`，DSH 宿主内）与控制台（`src/console/`，sidecar 独立页）共用本规范；页面级覆盖写入 `design-system/easel-console/pages/<page>.md`，无覆盖时以本文件为准。

## 1. 身份原则

- **纸面工作台**：纸色底（`--dsw-alias-bg-base` 浅色 `#f7f8f9` / 暗色 `#101214`），白卡片为面，发丝线（0.5px border）为分隔，不堆阴影。
- **品牌渐变**（青 `#158f9a` → 靛 `#3f56a8`）只出现在 wordmark 与主按钮填充，不作装饰扩散。
- **每屏一个主动作**：primary 按钮唯一，其余 outline/ghost 层级递减。
- **浅色为主**，跟随系统 `prefers-color-scheme` 自动切暗色；两套主题的令牌成对定义在 `src/console/console.css` 的 `:root`。
- 状态用五色语义（success/warn/error/business/idle），颜色永不单独承载含义，必配图标或文字（`StageMark`/`Dot` 模式）。

## 2. Token 层

定义在 `src/client/client.css` 顶部 `:root`，前缀 `--dt-`（与 DSH 宿主的 `--dsw-*`/`--ds-*` 永不冲突）。改值只改这一处。

### 字阶（字号/行高，中文优先）

| Token | 值 | 角色 | 代表类 |
|---|---|---|---|
| `--dt-fs-caption` / `--dt-lh-caption` | 12/18 | 最小可读文本：标签、芯片 | `dt-tag` `dt-chip` `dt-changed-tag` |
| `--dt-fs-meta` / `--dt-lh-meta` | 13/20 | 元信息：时间、表格、mono、阶段标 | `dt-row-meta` `dt-table` `dt-stage` `dt-mono` `dt-pre` |
| `--dt-fs-body` / `--dt-lh-body` | 14/22 | 正文：段落、事件、键值、控件标签 | `dt-md` `dt-event-text` `dt-kv` `dt-hint` `dt-btn` |
| `--dt-fs-title` / `--dt-lh-title` | 15/24 | 行/卡片标题 | `dt-row-title` `dt-open` `dt-row-label` `dt-stat-value` |
| `--dt-fs-head` / `--dt-lh-head` | 16/24 | 区块头、面板标题、模态标题 | `dt-title` `dt-section-title` `dt-status-title` `dt-settings-title` |
| `--dt-fs-page` / `--dt-lh-page` | 22/30 | 页面标题 | `dt-page-title h2` |

规则：**11px 清零**，任何文本不小于 12px；行高比 1.5–1.7；正文行长上限由 `max-width` 容器（面板 960 / 控制台 1040）约束。

### 页面骨架类

| 类 | 角色 |
|---|---|
| `dt-header` `dt-header-title` `dt-header-hint` `dt-header-actions` | 页头带：页面名（page 字阶）、其下一行提示、右侧页面自身动作 |
| `dt-stat-row` `dt-stat-tile` `dt-stat-tile-value` `dt-stat-tile-label` | 统计块：数值 page 字阶 / 800 在上，label caption 在下 |
| `dt-empty` `dt-empty-icon` `dt-empty-title` `dt-empty-hint` `dt-empty-action` | 空态：缺了什么、一行提示与引导动作 |

### 控件与几何

| Token | 值 | 用途 |
|---|---|---|
| `--dt-control-h` / `--dt-control-h-sm` | 36 / 30 | 按钮 md / sm |
| `--dt-input-h` | 36 | 输入框、下拉 |
| `--dt-touch-h` | 44 | 触屏最小命中（表单输入、卡片操作） |
| `--dt-radius-s/m/l/xl` | 6/10/16/20 | 芯片、输入、卡片、模态；胶囊按钮例外（= 高度一半） |
| `--dt-speed` | 150ms | hover/focus 过渡时长 |

## 3. 布局与滚动架构

- **控制台壳**（`console.css`）：`.console-shell` 为 `100dvh` 双列 grid（`grid-template-rows: auto minmax(0,1fr)`）；`.console-nav` 与 `.console-main` **各自 `overflow-y: auto` 独立滚动**，`scrollbar-gutter: stable`，壳自身 `overflow: hidden`。左栏永不跟着右栏滚。
- `.console-main` 是容器查询锚（`container-type: inline-size`），共享视图的 `@container (max-width: 640px)` 折叠规则在控制台内由此生效。
- **≤720px**：壳退化为文档流，nav 变横向 `position: sticky; top: 0`，body 整页滚动。
- **DSH 面板**：滚动契约不变——`.dt-page` 自持滚动（宿主拥有外框），`.dt-embedded` 不滚动。
- **禁止**在页面内栏再造 overflow 滚动容器：深链 `scrollIntoView`（thread/source/settings-kit）依赖滚动祖先链；粘性 `.dt-savebar` 必须是其块元素的直接子元素（焦点归还契约）。

## 4. 色彩

- 全部走 `--dsw-alias-*` 令牌名，两套主题的值成对维护在 `console.css`；**组件里不写裸 hex**（历史 layer 五色除外：discover `#0ea5e9` / plan `#7c3aed` / produce `#db2777` / publish `#059669` / attribute `#d97706`，仅用于内容分层标记）。
- 对比度：正文 ≥ 4.5:1，大字与图形 ≥ 3:1；暗色下品牌青提亮为 `#28b3be`。

## 5. 字体

离线工具，**零外联字体**；只允许系统栈，禁止声明未加载的 webfont 家族：

- 界面：`system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`
- wordmark（衬线斜体）：`'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Songti SC', serif`
- 代码：`var(--ds-font-family-code, ui-monospace, Menlo, monospace)`

## 6. 交互规则

- 所有可交互元素：`focus-visible` 焦点环（2px `--dsw-alias-brand-primary`）+ `cursor: pointer`；焦点环不得移除。
- hover/选中过渡统一 `var(--dt-speed) ease`；`prefers-reduced-motion: reduce` 时全部过渡/动画关闭（spinner 保留）。
- hover 展示的操作必须有触屏兜底（`.dt-reveal` 的 `@media (hover: none)` 模式）。
- 模态：焦点陷阱 + Esc/背景关闭 + 焦点归还（`Modal` 已实现）；遮罩 `blur(8px)` 表意"背景搁置"。
- 异步按钮：`disabled` + spinner（`dt-btn-busy`），100ms 内必有反馈。
- 列表加载：手动「加载更多」+ 分页 limit，不做无限滚动。
- 离线条是布局行（grid row），不是浮层，永不遮挡内容。

## 7. 命名与工程约束

- `dt-*` = 共享面板类（`src/client/client.css`），受 `tests/styles.spec.ts` 约束：必须被 src/client 代码引用、**每行一条规则**、同类选择器块内不重复。
- `console-*` = 控制台壳与皮肤专属（`src/console/console.css`），可引用 `--dt-*` token。
- 新共享类先在此登记角色，再写样式；console 皮肤规则的 specificity 不得压过 `dt-btn` 体系（按钮统一走 `Button` 原语）。
- CSS 由 JS 注入（`?raw` + `<style>`），`index.html` 内联关键背景色防首帧白闪。

## 8. 验收清单（交付前逐项过）

- [ ] 字号 ≥ 12px；正文 14/22；无 11px 残留
- [ ] 左右栏独立滚动；375 / 768 / 1024 / 1440 四档无横向滚动、无遮挡
- [ ] 浅/暗两主题正文对比度 ≥ 4.5:1
- [ ] 键盘走查：Tab 顺序合理、焦点环可见、模态可 Esc
- [ ] `prefers-reduced-motion` 下无过渡
- [ ] 触屏命中 ≥ 44px（表单与卡片操作）
- [ ] `pnpm check` 全绿（含 styles.spec / docs.spec / class-docs）
