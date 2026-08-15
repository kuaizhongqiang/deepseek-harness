/**
 * Model-facing `describe_image` tool: describes an image by calling a configurable
 * OpenAI chat-completions vision endpoint (Xiaomi MiMo by default), reading the
 * image from a session attachment or a disk path. The main conversation model
 * stays text-only — it calls this tool and consumes the returned description.
 *
 * The endpoint protocol is the OpenAI standard (`image_url` with a base64 data
 * URI), so any OpenAI-compatible vision gateway is a configuration change.
 *
 * @module @deepseek-ai/dsh-tool-describe-image
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseImageRefHint } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
// Type-only: loads the ctx.credentials Context merge so ctx.get is typed.
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

export const name = 'tool-describe-image'
export const inject = ['tools']

/** Default vision endpoint: Xiaomi MiMo, OpenAI chat-completions standard. */
export const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
/** Default vision model. */
export const DEFAULT_MODEL = 'mimo-v2.5'
/** Default credential reference resolved through the credentials seam. */
export const DEFAULT_API_KEY_ENV = 'MIMO_API_KEY'
/** Default per-request endpoint timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60_000
/** Default vision response token budget. */
export const DEFAULT_MAX_TOKENS = 1024
/** Default per-image byte cap, matching the attachment store's default. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
/** Default accepted raster media types (the OpenAI-standard set plus BMP). */
export const DEFAULT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'] as const

/** Configuration for the vision backend the tool calls. */
export interface Config {
  /** OpenAI chat-completions endpoint origin, e.g. `https://api.xiaomimimo.com/v1`. */
  baseURL?: string
  /** Vision model id the endpoint accepts. */
  model?: string
  /** Credential reference resolved per call through `ctx.credentials`, falling back to the environment. */
  apiKeyEnv?: string
  /** Per-request endpoint timeout in milliseconds. */
  timeoutMs?: number
  /** Vision response token budget. */
  maxTokens?: number
  /** Per-image byte cap. */
  maxBytes?: number
  /** Accepted raster media types; a file or attachment outside this set is refused. */
  allowedMediaTypes?: string[]
}

/** Schemastery configuration for the tool. */
export const Config: z<Config> = z.object({
  baseURL: z.string(),
  model: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  timeoutMs: z.natural(),
  maxTokens: z.natural(),
  maxBytes: z.natural(),
  allowedMediaTypes: z.array(z.string()),
})

/** Extension-to-media-type map for disk paths (the tool cannot sniff bytes). */
const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

/** Media type for one disk path, or undefined for an unknown extension. */
function mediaTypeForPath(path: string): string | undefined {
  return EXTENSION_MEDIA_TYPES[extname(path).toLowerCase().replace('.', '')]
}

/**
 * Search one event's carriers for an image-attachment reference matching an id:
 * direct image blocks (vision sessions) and text hints (converted sessions).
 */
function imageRefInEvent(event: SessionEvent, attachmentId: string): ImageAttachmentRef | undefined {
  const data = event.data as {
    content?: unknown
    message?: { content?: unknown }
    inserted?: Array<{ content?: unknown }>
  }
  const scan = (content: unknown): ImageAttachmentRef | undefined => {
    if (!Array.isArray(content)) return undefined
    for (const value of content) {
      if (typeof value !== 'object' || value === null) continue
      const block = value as { type?: unknown; attachment?: unknown; text?: unknown; content?: unknown }
      if (block.type === 'image') {
        const ref = block.attachment
        // Typed content blocks always carry a reference; the shape guard is
        // defensive against malformed logged content.
        if (typeof ref !== 'object' || ref === null) continue
        if (String((ref as ImageAttachmentRef).attachmentId) === attachmentId) return ref as ImageAttachmentRef
      }
      if (block.type === 'text') {
        if (typeof block.text !== 'string') continue
        const hint = parseImageRefHint(block.text)
        if (hint === undefined) continue
        if (String(hint.attachmentId) === attachmentId) return hint
      }
      if (block.type === 'tool-result') {
        const nested = scan(block.content)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }
  return scan(data.content) ?? scan(data.message?.content)
    ?? data.inserted?.flatMap(inserted => scan(inserted.content) ?? [])[0]
}

/** Resolve the durable reference for one session attachment id, or undefined. */
function findAttachmentRef(events: readonly SessionEvent[], attachmentId: string): ImageAttachmentRef | undefined {
  for (const event of events) {
    const found = imageRefInEvent(event, attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}

/** The resolved image source handed to the vision call. */
interface ImageSource {
  /** Raw encoded bytes. */
  data: Uint8Array
  /** Raster media type. */
  mediaType: string
  /** Human label for diagnostics. */
  label: string
}

/** Read and media-type one image source (attachment or path). */
async function resolveImageSource(
  attachments: AttachmentStore | undefined,
  events: readonly SessionEvent[],
  args: { attachmentId?: string; path?: string },
): Promise<ImageSource> {
  if (args.attachmentId !== undefined) {
    if (attachments === undefined) throw new Error('describe_image: no attachment service is mounted')
    const ref = findAttachmentRef(events, args.attachmentId)
    if (ref === undefined) {
      throw new Error(`describe_image: attachment ${JSON.stringify(args.attachmentId)} is not referenced by this session`)
    }
    const stored = await attachments.readImage(ref)
    return { data: stored.data, mediaType: stored.ref.mediaType, label: ref.name ?? String(ref.attachmentId) }
  }
  const path = args.path
  /* v8 ignore next 2 -- the execute path enforces exactly-one before resolving, so path is always present here */
  if (path === undefined) throw new Error('describe_image: specify attachmentId or path')
  const mediaType = mediaTypeForPath(path)
  if (mediaType === undefined) {
    throw new Error(`describe_image: cannot determine the image type of ${JSON.stringify(path)} (supported: png/jpg/jpeg/webp/gif/bmp)`)
  }
  const data = new Uint8Array(await readFile(path))
  return { data, mediaType, label: path }
}

/** One OpenAI chat-completions vision response (non-streaming). */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>
}

/**
 * Describe one image through the configured OpenAI-compatible endpoint.
 * @param source - the image bytes and media type.
 * @param prompt - the vision task text.
 * @param options - endpoint facts and the resolved credential.
 * @returns the model's description text.
 */
async function describeImage(
  source: ImageSource,
  prompt: string,
  options: {
    baseURL: string
    model: string
    apiKey: string
    maxTokens: number
    signal: AbortSignal
  },
): Promise<string> {
  const dataUri = `data:${source.mediaType};base64,${Buffer.from(source.data).toString('base64')}`
  const response = await fetch(`${options.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      }],
      max_tokens: options.maxTokens,
    }),
    signal: options.signal,
  })
  if (!response.ok) {
    // The body read is best-effort on an already-failed response; a socket that
    // dies mid-body leaves no excerpt, not a second failure.
    /* v8 ignore next 2 -- the catch covers a body read on a closing socket, unreachable from the mock and real flows */
    const body = await response.text().catch(() => '')
    throw new Error(`describe_image: vision endpoint answered ${response.status}${body.length === 0 ? '' : `: ${body.slice(0, 400)}`}`)
  }
  const parsed = await response.json() as ChatCompletionResponse
  const description = parsed.choices?.[0]?.message?.content
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error('describe_image: vision endpoint returned no description')
  }
  return description
}

/**
 * Register the `describe_image` tool. Credentials resolve through the optional
 * credentials seam, falling back to the launching environment, exactly as
 * `dsh-llm-pi-ai` resolves provider keys.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - the vision backend facts.
 */
export function apply(ctx: Context, config: Config): void {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL
  const model = config.model ?? DEFAULT_MODEL
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
  // Schemastery materializes an absent array as `[]`, so "unset" means either;
  // an explicitly empty list would accept nothing and is refused the same way.
  const configuredMediaTypes = config.allowedMediaTypes
  const allowedMediaTypes = new Set(
    configuredMediaTypes === undefined || configuredMediaTypes.length === 0 ? DEFAULT_MEDIA_TYPES : configuredMediaTypes,
  )

  const resolveApiKey = async (): Promise<string> => {
    const ref = credentialRef(apiKeyEnv)
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : launchEnvironmentOf(ctx).get(apiKeyEnv)?.value
    if (hit === undefined || hit.length === 0) {
      throw new Error(`describe_image: no credential for ${apiKeyEnv}; set it through the credentials service or export it in the environment`)
    }
    return hit
  }

  ctx.tools.register(defineTool({
    name: 'describe_image',
    description: 'Describe the content of one image. Pass either attachmentId (an image the user attached to this '
      + 'conversation, e.g. pasted or dropped) or path (a file on disk). The vision model reads the image and returns '
      + 'a text description; use it when the user asks about an attached image or an image file.',
    parameters: {
      attachmentId: { type: 'string', description: 'The id of an image the user attached to this conversation (pasted or dropped). Exactly one of attachmentId and path is required.' },
      path: { type: 'string', description: 'Absolute path of an image file on disk (png/jpg/jpeg/webp/gif/bmp). Exactly one of attachmentId and path is required.' },
      prompt: { type: 'string', description: 'What to look for; defaults to describing the image.' },
      maxTokens: { type: 'integer', description: 'Vision response token budget; defaults to the configured value.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true, description: 'The vision model\'s description of the image.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.description }],
    },
    async execute(args, exec) {
      // The parameter map cannot express a cross-field rule, so exactly-one is
      // enforced here — the operation that makes the decision.
      if ((args.attachmentId === undefined) === (args.path === undefined)) {
        throw new Error('describe_image: exactly one of attachmentId and path is required')
      }
      if (args.attachmentId !== undefined && exec.agent === undefined) {
        throw new Error('describe_image: attachmentId requires an owning agent session')
      }
      const source = await resolveImageSource(
        ctx.get('attachments'),
        exec.agent?.session.events ?? [],
        {
          ...args.attachmentId === undefined ? {} : { attachmentId: args.attachmentId },
          ...args.path === undefined ? {} : { path: args.path },
        },
      )
      if (!allowedMediaTypes.has(source.mediaType)) {
        throw new Error(`describe_image: unsupported image type ${JSON.stringify(source.mediaType)} (allowed: ${[...allowedMediaTypes].join(', ')})`)
      }
      if (source.data.byteLength > maxBytes) {
        throw new Error(`describe_image: image ${JSON.stringify(source.label)} is ${source.data.byteLength} bytes, over the ${maxBytes}-byte limit`)
      }
      const apiKey = await resolveApiKey()
      const timeoutController = new AbortController()
      const timeout = setTimeout(() => {
        timeoutController.abort(new Error(`describe_image: vision endpoint timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      try {
        const description = await describeImage(source, args.prompt ?? 'Describe the content of this image in detail.', {
          baseURL,
          model,
          apiKey,
          maxTokens: args.maxTokens ?? maxTokens,
          signal: AbortSignal.any([exec.signal, timeoutController.signal]),
        })
        return { description }
      } finally {
        clearTimeout(timeout)
        timeoutController.abort()
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Read image', kind: 'read', rawInput: args }),
  }))
}
