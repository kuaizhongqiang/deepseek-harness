# Agent Note: llm-pi-ai 内置小米 MiMo 视觉 provider

Status: implemented

[English](2026-08-15-mimo-vision-provider.md) | 中文

## 问题

本 fork 的桌面 / VSCode / Web 客户端会在用户消息中附带图片，但没有任何 provider 路由开箱即用地提供视觉模型。pi-ai 0.82 没有 xiaomi 目录，而设置 UI 声明的路由无法把模型标记为支持图片——模型编辑器不暴露 `input` 多模态字段，路由回退到 `[text]`——因此每个带图片的请求在到达任何 provider 之前就会被 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝。

## 决策

`dsh-llm-pi-ai` 增加一个 harness 声明的内置目录（`src/builtin.ts`）：`mimo` 路由提供 `mimo-v2.5`（文本 + 图片，1M 上下文 / 128K 输出）和 `mimo-v2.5-pro`（仅文本），端点为 OpenAI 兼容的 `https://api.xiaomimimo.com/v1`。内置条目与 pi-ai 目录进入同一个 provider 索引——`catalogProviders()`、`catalogModels()`、`catalogProviderIds()` 都将其合并进来——因此只声明 `apiKeyEnv: MIMO_API_KEY` 的 profile 即可解析整条路由，设置页的 Models 面板出现带密钥输入框的 `mimo` 行，`buildProvider` 像复用 pi-ai 目录 provider 一样复用该内置 provider。harness 已有的图片管线——粘贴 / 拖拽 / 多图草稿、durable attachment 存储、host 图片准入、pi-ai 的 base64 `image_url` 编码——无需更多配置即可端到端提供视觉能力。

MiMo 采用 DeepSeek 风格推理 wire（`reasoning_content`、`thinking`、`reasoning_effort`），因此内置模型声明 `compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true }`。其 `thinkingLevelMap` 把每个 pi-ai 等级映射为对端点验证过的取值（2026-08）：`low` / `medium` / `high` 被接受，`minimal` 被 400 拒绝，因此 `minimal` 映射为 `low`，`xhigh` / `max` 映射为 `high`；`off` 映射为 `low`，避免显式选择 Off 时发送裸字符串，而默认无 effort（pi-ai deepseek 分发中的 `off !== null`）发送 `thinking: { type: 'disabled' }`——验证过的快速路径，因为 MiMo 默认会思考。

## 曾考虑的替代方案

- **仅以用户设置交付该路由**（文档加上手写 `settings.yaml` 的 `defaultInput: [text, image]`）。否决：设置 UI 无法表达多模态，图片路径在该 fork 要交付的产品表面上仍然不可达。
- **给设置模型编辑器加 `input` 多模态字段**（`ui-settings-models`）。延后：内置条目已解决随包交付的用例，而该字段会改动上游 `ui-settings-models`；它仍是需要 harness 未内置的其它 OpenAI 兼容视觉网关的用户的路径。
- **单独的 `@deepseek-ai/dsh-llm-mimo` 包**。否决：`llm-pi-ai` 的目录没有扩展点，为容纳第二个包而新增扩展点，会扩大上游改动面，超过本改动的小型内置表。

## 结果

- 一行配置（或 Models 面板的密钥输入框）即可使用 MiMo，包括图片；整条链路由 `tests/provider-apis.e2e.ts` 的 `mimo` 用例（无 `MIMO_API_KEY` 时自跳过）和 `tests/catalog.spec.ts` 的内置用例固定。
- 改动触及上游 `llm-pi-ai`（新增 `src/builtin.ts`，`catalog.ts` / `provider.ts` 小规模合并），换取一流的视觉 UX；改动是增量的，fork 的合并纪律将其作为小型补丁携带。
- 推理映射钉在一次性验证过的 wire 事实上；若 MiMo 日后接受 `minimal`，该映射保持保守，不会出错。
