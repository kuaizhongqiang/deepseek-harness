# Agent Note: describe_image tool — images understood through a tool, main model stays text-only

Status: implemented

English | [中文](2026-08-15-describe-image-tool.zh.md)

## Problem

The fork's web/desktop/VSCode clients attach images to user messages, but the main conversation model is DeepSeek V4 flash, which is text-only: any image-bearing prompt was refused with `MODEL_DOES_NOT_SUPPORT_IMAGES` before it reached a model, and a session that already contains images could not switch back to a text-only model. The product requirement is to keep the main model on DeepSeek and let it *see* images by calling a tool, with the vision model (Xiaomi MiMo by default) executing behind that tool.

## Decision

A new tool plugin `@deepseek-ai/dsh-tool-describe-image` (`packages/vision/tool-describe-image`) plus a host-side attachment-chain adjustment in `dsh-host-apiproxy`.

**Tool.** `describe_image` takes exactly one of `attachmentId` (a durable image the user pasted/dropped) or `path` (a disk file), plus optional `prompt` (default: describe the image) and `maxTokens`. It reads the image bytes, calls an OpenAI chat-completions vision endpoint (`baseURL`/`model`/`apiKeyEnv`/`timeoutMs`/`maxBytes`/`allowedMediaTypes` configured on the tool, defaulting to Xiaomi MiMo `https://api.xiaomimimo.com/v1` + `mimo-v2.5` + `MIMO_API_KEY`), and returns the model's text description. The endpoint protocol is the OpenAI standard (`image_url` with a base64 data URI), so any OpenAI-compatible vision gateway is a config change, not a code change. The `attachmentId` reference is resolved from the calling agent's session log and rejected when the session does not reference it, matching `session.attachment` authorization.

**Attachment chain (host).** In the `session.prompt` handler, when the prompt contains images and the session's model is text-only and `describe_image` is registered, the images are stored as durable attachments (existing path) and the user message content is converted: each image block becomes a text hint that embeds the full `ImageAttachmentRef` as a stable string (`dsh-attachment`'s `imageRefHint`/`parseImageRefHint`), e.g. `[图片附件 <id> (<mediaType>, <width>×<height>, <bytes>B, <name>) — 使用 describe_image（attachmentId=<id>）查看]`. The model request therefore carries no image blocks and no rejection fires; `referencedImage` (api-proxy) parses the hint so `session.attachment` authorization and UI thumbnail loading keep working; the `selectModel` image guard no longer flags the session, so the user can switch models freely. When the model is vision-capable the current image path is unchanged; when the tool is not mounted the current rejection is unchanged.

**Model-visible ⟺ logged.** The user message event stores exactly the hint text the model sees; the attachment bytes live in the attachment service and are referenced by the session through the hint. The `describe_image` tool call/result are ordinary session events. Everything is reconstructable from the log.

## Alternatives considered

- **Automatic per-turn model routing** (image rounds silently use a vision model). Rejected: it changes the session's model ownership per turn, fights the single-route session design, and the "model-visible ⟺ logged" rule would still surface the actual model — no honest version of "无痕".
- **Keep image blocks in the logged message and strip them in agent-loop request assembly.** Rejected: touches the core loop and its documented architecture for a projection only the web/API path needs; the hint conversion keeps the change inside `dsh-host-apiproxy`.
- **A `{type:'attachment'}` wire part for the prompt.** Rejected: new prompt-content wire type ripples through client, host schema, and history rendering; reusing the existing `image` wire with host-side conversion is a smaller surface.

## Consequences

- The main model stays DeepSeek V4 flash; image understanding is a tool call. Verified end to end against the real endpoints (2026-08-15): DeepSeek received the hint, called `describe_image` with the attachment id, MiMo described the QR fixture, and DeepSeek answered from that description; the session log attributes the model as DeepSeek throughout.
- The hint string is parsed by `referencedImage` and the tool; the format is owned by `dsh-attachment` helpers so writer and readers cannot drift.
- A converted (hint) session renders the hint as text in the current web history, not a thumbnail; the draft rail and `session.attachment` still work, and a future UI can render hints as images.
- Coverage: the tool package and hint module hit per-file 100%; the api-proxy conversion is covered by the model-selection suite; a keyless self-skipping e2e (`e2e-real.e2e.ts`) pins the real-chain behavior.
