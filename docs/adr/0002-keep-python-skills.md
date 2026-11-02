# Easel 技能层保持 Python 原样搬运

Easel 的 115 个技能（SKILL.md + Python 脚本，含音视频处理、Playwright 发布器）原样搬入新项目，不重写为 TypeScript；worker 经 shell 调用脚本，保留 outputs/ 文件产物协议。考虑过重写统一技术栈与只挑核心技能移植——重写工作量巨大（MVP 遥遥无期），挑选则引入持续的碎片搬运。代价：运行时长期依赖 Python 3.10+/ffmpeg/Playwright（与 Easel 现状一致，非新增负担）。
