# Agent Note: describe_image 工具 —— 通过工具理解图片，主模型保持纯文本

Status: implemented

[English](2026-08-15-describe-image-tool.md) | 中文

## 问题

fork 的 Web / 桌面 / VSCode 客户端会在用户消息中附带图片，但主对话模型是 DeepSeek V4 flash（纯文本）：任何带图的 prompt 在到达模型之前就会被 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝，而已包含图片的会话也无法切回纯文本模型。产品要求是主模型始终是 DeepSeek，让它通过**工具调用**"看图"，视觉模型（默认小米 MiMo）在工具背后执行。

## 决策

新增工具插件 `@deepseek-ai/dsh-tool-describe-image`（`packages/vision/tool-describe-image`），并在 `dsh-host-apiproxy` 中做一处附件链路调整。

**工具。** `describe_image` 恰好接收 `attachmentId`（用户粘贴/拖入图片产生的 durable 附件）或 `path`（磁盘文件）之一，另有可选 `prompt`（默认描述图片）与 `maxTokens`。工具读取图片字节，调用 OpenAI chat-completions 视觉端点（`baseURL` / `model` / `apiKeyEnv` / `timeoutMs` / `maxBytes` / `allowedMediaTypes` 为工具配置项，默认小米 MiMo `https://api.xiaomimimo.com/v1` + `mimo-v2.5` + `MIMO_API_KEY`），返回模型的文本描述。端点协议是 OpenAI 标准（`image_url` + base64 data URI），因此任意 OpenAI 兼容视觉网关都是配置变更而非代码变更。`attachmentId` 引用从调用方 agent 的会话日志中解析，会话未引用时拒绝，与 `session.attachment` 授权一致。

**附件链路（host）。** 在 `session.prompt` 处理器中，当 prompt 含图片、会话模型为纯文本且 `describe_image` 已注册时：图片按现有路径存为 durable 附件，用户消息内容被转换——每个 image block 变为一条内嵌完整 `ImageAttachmentRef` 的文本提示（`dsh-attachment` 的 `imageRefHint` / `parseImageRefHint`），例如 `[图片附件 <id> (<mediaType>, <width>×<height>, <bytes>B, <name>) — 使用 describe_image（attachmentId=<id>）查看]`。模型请求因此不含 image block，不再触发拒绝；`referencedImage`（api-proxy）解析该提示，`session.attachment` 授权与 UI 缩略图加载保持可用；`selectModel` 的图片守卫不再标记该会话，用户可以自由切换模型。当模型支持图片时走原有图片路径；当工具未挂载时保留原有拒绝。

**model-visible ⟺ logged。** 用户消息事件存储的正是模型看到的提示文本；附件字节位于附件服务，通过提示被会话引用。`describe_image` 的工具调用/结果都是普通会话事件。日志可完整重建一切。

## 曾考虑的替代方案

- **按轮自动路由到视觉模型**（图片轮静默使用视觉模型）。否决：它让会话的模型归属逐轮变化，与"会话单一路由"的设计冲突，且"model-visible ⟺ logged"规则仍会暴露真实模型——不存在诚实的"无痕"版本。
- **日志保留 image block、在 agent-loop 请求组装时剥离**。否决：为只有 Web/API 路径需要的投影改动核心循环及其文档化架构；提示转换把改动留在 `dsh-host-apiproxy` 内。
- **为 prompt 增加 `{type:'attachment'}` wire 类型**。否决：新 prompt 内容类型会波及客户端、host schema 与历史渲染；复用现有 `image` wire + host 端转换的改动面更小。

## 结果

- 主模型始终是 DeepSeek V4 flash，图片理解是工具调用。已用真实端点端到端验证（2026-08-15）：DeepSeek 收到提示后调用 `describe_image`（attachmentId），MiMo 描述了 QR fixture，DeepSeek 基于该描述作答；会话日志全程把模型归属为 DeepSeek。
- 提示字符串被 `referencedImage` 与工具解析；格式由 `dsh-attachment` 助手持有，写入方与读取方不会漂移。
- 转换（hint）会话在当前的 Web 历史中以文本渲染提示，而非缩略图；草稿 rail 与 `session.attachment` 仍然可用，未来 UI 可以把 hint 渲染为图片。
- 覆盖：工具包与 hint 模块达到 per-file 100%；api-proxy 转换由模型选择套件覆盖；keyless 自跳过的 e2e（`e2e-real.e2e.ts`）固定真实链路行为。
