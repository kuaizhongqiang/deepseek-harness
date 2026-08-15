# Agent Note: read_image tool — images understood through a tool, main model stays text-only

Status: proposed

English | [中文](2026-08-15-read-image-tool.zh.md)

## Problem

The fork's web/desktop/VSCode clients attach images to user messages, but the main conversation model is DeepSeek V4 flash, which is text-only: any image-bearing prompt is refused with `MODEL_DOES_NOT_SUPPORT_IMAGES` before it reaches a model, and a session that already contains images cannot switch back to a text-only model. The product requirement is to keep the main model on DeepSeek and let it *see* images by calling a tool, with the vision model (Xiaomi MiMo by default) executing behind that tool.

## Proposal

A new tool plugin `@deepseek-ai/dsh-tool-read-image` (`packages/vision/tool-read-image`) plus a host-side attachment-chain adjustment in `dsh-host-apiproxy`.

**Tool.** `read_image` takes exactly one of `attachmentId` (a durable image the user pasted/dropped) or `path` (a disk file), plus optional `prompt` (default: describe the image) and `maxTokens`. It reads the image bytes, calls an OpenAI chat-completions vision endpoint (`baseURL`/`model`/`apiKeyEnv`/`timeoutMs` configured on the tool, defaulting to Xiaomi MiMo `https://api.xiaomimimo.com/v1` + `mimo-v2.5` + `MIMO_API_KEY`), and returns the model's text description. The endpoint protocol is the OpenAI standard (`image_url` with a base64 data URI), so any OpenAI-compatible vision gateway is a config change, not a code change.

**Attachment chain (host).** In the `session.prompt` handler, when the prompt contains images and the session's model is text-only and `read_image` is registered, the images are stored as durable attachments (existing path) and the user message content is converted: each image block becomes a text hint that embeds the full `ImageAttachmentRef` as a stable string (helper in `dsh-attachment`), e.g. `[图片附件 <id> (<mediaType>, <width>×<height>, <bytes>B, <name>) — 使用 read_image（attachmentId=<id>）查看]`. The model request therefore carries no image blocks and no rejection fires; `referencedImage` (api-proxy) learns to parse the hint so `session.attachment` authorization and UI thumbnail loading keep working; the `selectModel` image guard no longer flags the session, so the user can switch models freely. When the model is vision-capable the current image path is unchanged; when the tool is not mounted the current rejection is unchanged.

**Model-visible ⟺ logged.** The user message event stores exactly the hint text the model sees; the attachment bytes live in the attachment service and are referenced by the session through the hint. The `read_image` tool call/result are ordinary session events. Everything is reconstructable from the log.

## Alternatives considered

- **Automatic per-turn model routing** (image rounds silently use a vision model). Rejected: it changes the session's model ownership per turn, fights the single-route session design, and the "model-visible ⟺ logged" rule would still surface the actual model — no honest version of "无痕".
- **Keep image blocks in the logged message and strip them in agent-loop request assembly.** Rejected: touches the core loop and its documented architecture for a projection only the web/API path needs; the hint conversion keeps the change inside `dsh-host-apiproxy`.
- **A `{type:'attachment'}` wire part for the prompt.** Rejected: new prompt-content wire type ripples through client, host schema, and history rendering; reusing the existing `image` wire with host-side conversion is a smaller surface.

## Acceptance criteria

- Default model stays DeepSeek V4 flash regardless of image use.
- Pasting/dropping an image then prompting: DeepSeek calls `read_image` (attachmentId path) and answers from the returned description (verified end to end against the real MiMo endpoint with a QR-code fixture).
- `read_image` also works with a `path` argument.
- Vision-capable models keep receiving real image content; sessions without the tool mounted keep the current rejection.
- `test:coverage` per-file 100% on the new package and the touched host paths; keyless replay/unit coverage for the conversion; docs (tool README, root README, this note) updated.

## Risks

- The hint string is parsed by `referencedImage`; the format is owned by `dsh-attachment` helpers so writer and readers cannot drift.
- A text-only hint in history renders as text (not a thumbnail) in the current UI; the draft rail and `session.attachment` still work, and a future UI can render hints as images.
