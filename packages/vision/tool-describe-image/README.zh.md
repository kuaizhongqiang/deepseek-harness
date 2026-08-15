# @deepseek-ai/dsh-tool-describe-image

[English](README.md) | 中文

面向模型的 `describe_image` 工具：通过可配置的 OpenAI 兼容视觉端点描述一张图片，图片来源可以是会话附件或磁盘路径。主对话模型保持纯文本——它调用此工具并消费返回的描述。

## 功能

在 `ctx.tools` 注册一个工具 `describe_image`。模型必须传入**恰好一个**：

- `attachmentId` — 用户附加到本会话的 durable 图片（粘贴或拖入）。引用从调用方 agent 的会话日志中解析：image block（视觉模型会话）或 image-ref hint 文本块（转换后的纯文本会话，见下文）。会话未引用的 id 会被拒绝，与 `session.attachment` 授权一致。
- `path` — 磁盘上图片文件的绝对路径（`png` / `jpg` / `jpeg` / `webp` / `gif` / `bmp`）。

可选 `prompt`（视觉任务；默认描述图片）与 `maxTokens`（响应预算）。工具读取字节，以 OpenAI 标准 `image_url` data URI 调用 `POST {baseURL}/chat/completions`，返回视觉模型的文本 `{ description }`。

## 视觉后端

端点协议是 OpenAI chat-completions 标准，因此**任意 OpenAI 兼容视觉网关都只是配置变更，而非代码变更**。配置（全部可选，括号内为默认值）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `baseURL` | `https://api.xiaomimimo.com/v1` | 端点来源；自动追加 `/chat/completions`。 |
| `model` | `mimo-v2.5` | 视觉模型 id（默认小米 MiMo）。 |
| `apiKeyEnv` | `MIMO_API_KEY` | 每次调用经 `ctx.credentials` 解析的凭证引用，回退到启动环境。 |
| `timeoutMs` | `60000` | 单次请求端点超时。 |
| `maxTokens` | `1024` | 响应 token 预算。 |
| `maxBytes` | `5 * 1024 * 1024` | 单张图片字节上限。 |
| `allowedMediaTypes` | png/jpeg/webp/gif/bmp | 接受的栅格媒体类型。 |

凭证引用缺失时大声失败（`no credential for <ref>`），绝不回退到无关的 ambient key。

## 附件链路（纯文本主模型）

当含图片的 prompt 落在纯文本会话模型上且本工具已挂载时，`dsh-host-apiproxy` 会把图片存为 durable 附件，并将每个 image block 替换为 image-ref hint 文本块（`dsh-attachment` 的 `imageRefHint`）。模型因此不接收图片内容——不再触发 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝——它看到 hint 与本工具，于是调用 `describe_image({ attachmentId })` 查看图片。支持图片的模型继续接收真实图片内容；未挂载本工具时保留原有拒绝。

## 校验

除 schema 的类型检查外，`execute` 强制 schema 无法表达的跨字段规则：`attachmentId` / `path` **恰好一个**。媒体类型不在 `allowedMediaTypes` 内的图片、超限图片、端点错误（非 2xx、超时、空描述）、未解析的附件，都以稳定的 `describe_image:` 消息拒绝。

## 导出形态

函数/命名空间插件：导出 `name` / `inject` / `apply`，**没有** default 导出。多余的 `export default` 会让 Loader 的 `unwrapExports` 折叠模块并丢弃 `inject`（见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 工具 schema

#### 模型所见

模型看到生成的 [`describe_image` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-describe-image)。

#### Token 影响

工具可见的每个请求都有固定 schema 成本；附带图片只发往视觉端点，不进入主模型。

#### KV 缓存影响

定义与可见性不变时前缀稳定；插件生命周期或作用域限制可能使该 schema 的复用失效。

### 工具调用历史与结果

#### 模型所见

每次助手工具调用携带已解析的来源（`attachmentId` 或 `path`）与可选的 `prompt` / `maxTokens`。成功原样返回视觉模型的描述文本。稳定失败信息包括 `describe_image: exactly one of attachmentId and path is required`、`describe_image: attachment <id> is not referenced by this session`、`describe_image: cannot determine the image type of <path>`、`describe_image: unsupported image type <type>`、`describe_image: image <label> is <bytes> bytes, over the <n>-byte limit`、`describe_image: no credential for <ref>`、`describe_image: vision endpoint answered <status>[: <body>]`、`describe_image: vision endpoint returned no description`、`describe_image: vision endpoint timed out after <n>ms`。

#### Token 影响

视觉响应 token 是工具结果；描述文本随后作为普通工具结果内容进入主模型上下文。

#### KV 缓存影响

描述文本是普通工具结果块；主模型缓存不携带任何图片特定内容。

## 已知限制与延后工作

- `path` 来源的媒体类型按文件扩展名判断，不嗅探字节。
- 转换（hint）会话在当前的 Web 历史中以文本渲染提示，而非缩略图；草稿 rail 与 `session.attachment` 仍然可用，未来 UI 可以把 hint 渲染为图片。
