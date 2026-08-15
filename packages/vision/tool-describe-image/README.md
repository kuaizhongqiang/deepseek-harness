# @deepseek-ai/dsh-tool-describe-image

English | [中文](README.zh.md)

The model-facing `describe_image` tool: describe an image through a configurable OpenAI-compatible vision endpoint, reading the image from a session attachment or a disk path. The main conversation model stays text-only — it calls this tool and consumes the returned description.

## What it does

Registers one tool, `describe_image`, on `ctx.tools`. The model passes **exactly one** of:

- `attachmentId` — a durable image the user attached to this conversation (pasted or dropped). The reference is resolved from the calling agent's session log: either an image block (a vision-model session) or an image-ref hint text block (a converted text-only session, see below). An id the session does not reference is rejected, matching `session.attachment` authorization.
- `path` — an absolute image file path on disk (`png`/`jpg`/`jpeg`/`webp`/`gif`/`bmp`).

Optional `prompt` (the vision task; defaults to describing the image) and `maxTokens` (response budget). The tool reads the bytes, calls `POST {baseURL}/chat/completions` with an OpenAI-standard `image_url` data URI, and returns the vision model's text as `{ description }`.

## Vision backend

The endpoint protocol is the OpenAI chat-completions standard, so **any OpenAI-compatible vision gateway is a configuration change, not a code change**. Configuration (all optional, defaults in parentheses):

| Field | Default | Meaning |
| --- | --- | --- |
| `baseURL` | `https://api.xiaomimimo.com/v1` | Endpoint origin; `/chat/completions` is appended. |
| `model` | `mimo-v2.5` | Vision model id (Xiaomi MiMo by default). |
| `apiKeyEnv` | `MIMO_API_KEY` | Credential reference resolved per call through `ctx.credentials`, falling back to the launching environment. |
| `timeoutMs` | `60000` | Per-request endpoint timeout. |
| `maxTokens` | `1024` | Response token budget. |
| `maxBytes` | `5 * 1024 * 1024` | Per-image byte cap. |
| `allowedMediaTypes` | png/jpeg/webp/gif/bmp | Accepted raster media types. |

A missing credential reference fails loud (`no credential for <ref>`), never falling through to an unrelated ambient key.

## Attachment chain (text-only main models)

When a prompt containing images lands on a text-only session model and this tool is mounted, `dsh-host-apiproxy` stores the images as durable attachments and replaces each image block with an image-ref hint text block (`dsh-attachment`'s `imageRefHint`). The model therefore receives no image content — no `MODEL_DOES_NOT_SUPPORT_IMAGES` rejection — and sees the hint plus this tool, so it calls `describe_image({ attachmentId })` to look at the image. Vision-capable models keep receiving real image content; without this tool mounted the historical rejection stays.

## Validation

Beyond the schema's type checks, `execute` enforces the cross-field rule the schema cannot express: **exactly one** of `attachmentId`/`path`. An image whose media type is outside `allowedMediaTypes`, an oversize image, an endpoint error (non-2xx, timeout, empty description), and an unresolved attachment are all rejected with stable `describe_image:` messages.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`describe_image` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-describe-image).

#### Token effect

Fixed schema cost on every request where the tool is visible; the attached image travels to the vision endpoint, not to the main model.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each assistant tool call carries the resolved source (`attachmentId` or `path`) plus optional `prompt`/`maxTokens`. Success returns the vision model's description text verbatim. Stable failures are `describe_image: exactly one of attachmentId and path is required`, `describe_image: attachment <id> is not referenced by this session`, `describe_image: cannot determine the image type of <path>`, `describe_image: unsupported image type <type>`, `describe_image: image <label> is <bytes> bytes, over the <n>-byte limit`, `describe_image: no credential for <ref>`, `describe_image: vision endpoint answered <status>[: <body>]`, `describe_image: vision endpoint returned no description`, and `describe_image: vision endpoint timed out after <n>ms`.

#### Token effect

The vision response tokens are the tool result; the description text then enters the main model's context as ordinary tool-result content.

#### KV Cache effect

The description text is a normal tool-result block; nothing image-specific rides the main model's cache.

## Known Limitations and Deferred Work

- Media type for the `path` source is detected from the file extension; the bytes are not sniffed.
- A converted (hint) session renders the hint as text in the current web history, not a thumbnail; the draft rail and `session.attachment` still work, and a future UI can render hints as images.
