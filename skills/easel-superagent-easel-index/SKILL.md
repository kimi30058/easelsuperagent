---
name: easel-superagent-easel-index
description: Easel 技能库导航索引——按发现/策划/创作/发布/归因五层分组列出可用技能与调用入口
---

# Easel 技能库索引

按内容工作流五层使用（技能经 skill 工具按名加载，脚本用 bash 在工作根目录执行）：

- **发现 discover**：skill-trending-topics、skill-rss-aggregator、skill-competitor-analysis、skill-hotlist-monitor
- **策划 plan**：skill-content-calendar、skill-topic-evaluator、skill-hook-generator、skill-profile-builder、skill-brand-onboarding
- **创作 produce**：copywriting、card-xiaohongshu、poster-hero、infographic、record-card、tts-voiceover、multi-voice-dubbing、video-editing、short-drama、novel-writer、paper-explainer、ai-video-gen、ai-music、voice-clone、auto-subtitle
- **发布 publish**：skill-xhs-publisher、skill-douyin-upload、skill-kuaishou-upload、skill-zhihu-publisher、skill-bilibili-upload、skill-channels-upload、skill-wechat-publisher、skill-cross-platform-publish、skill-quality-gate、skill-risk-scanner、skill-publish-checklist
- **归因 attribute**：skill-my-account、skill-publish-analytics、skill-comment-insights、skill-xhs-analyzer、skill-content-postmortem、skill-social-performance-review

完整清单以技能目录消息为准。日历读写统一走 `python skills/shared/scripts/calendar_ops.py`（CWD=工作根）。
