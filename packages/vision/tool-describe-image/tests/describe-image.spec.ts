import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { CallId, MessageId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** A parent Agent backed by a real Session — the tool reads `agent.session`. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

/** Append a converted user message (hint text) to the agent session. */
function attachHint(agent: Agent & { session: Session }, ref: ImageAttachmentRef): void {
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `[图片附件 ${String(ref.attachmentId)} (${ref.mediaType}, ${ref.width}×${ref.height}, ${ref.bytes}B)] — 查看此图片` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Append a raw user message with an image block (vision-model session). */
function attachImageBlock(agent: Agent & { session: Session }, ref: ImageAttachmentRef): void {
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'image', attachment: ref }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** A read-only attachment store serving one fixture image; mounted as a class. */
function fixtureStore(image: StoredImageAttachment): new (ctx: Context) => AttachmentStore {
  return class extends AttachmentStore {
    readonly imageLimits: ImageAttachmentLimits = {
      maxImageBytes: image.data.byteLength,
      maxImagesPerMessage: 1,
      maxMessageImageBytes: image.data.byteLength,
      maxImagePixels: image.ref.width * image.ref.height,
      mediaTypes: [image.ref.mediaType],
    }
    validateImage(): Promise<void> { return Promise.reject(new Error('read-only fixture')) }
    saveImage(): Promise<ImageAttachmentRef> { return Promise.reject(new Error('read-only fixture')) }
    readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
      if (String(ref.attachmentId) !== String(image.ref.attachmentId)) {
        return Promise.reject(new Error('unknown fixture attachment'))
      }
      return Promise.resolve(image)
    }
  }
}

/** A minimal OpenAI-compatible vision endpoint stand-in. */
interface MockServer {
  url: string
  paths: string[]
  bodies: unknown[]
  headers: IncomingMessage['headers'][]
  close: () => Promise<void>
}

const servers: MockServer[] = []

async function mockVisionServer(script: Array<{
  status?: number
  body?: string
  delayMs?: number
}>): Promise<MockServer> {
  const paths: string[] = []
  const bodies: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  let index = 0
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    paths.push(request.url ?? '')
    let raw = ''
    request.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    request.on('end', () => {
      bodies.push(raw.length === 0 ? undefined : JSON.parse(raw))
      headers.push(request.headers)
      const behavior = script[index] ?? { status: 500, body: 'script exhausted' }
      index++
      const reply = (): void => {
        response.writeHead(behavior.status ?? 200, { 'content-type': 'application/json' })
        response.end(behavior.body ?? JSON.stringify({ choices: [{ message: { content: 'a QR code' } }] }))
      }
      if (behavior.delayMs === undefined) reply()
      else setTimeout(reply, behavior.delayMs)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const mock: MockServer = {
    url: `http://127.0.0.1:${address.port}`,
    paths,
    bodies,
    headers,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
  servers.push(mock)
  return mock
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const QR_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: PNG.byteLength,
  width: 256,
  height: 256,
  name: 'qr.png',
}

const homes: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-describe-image-'))
  homes.push(dir)
  return dir
}

let callCounter = 0
function callReadImage(ctx: Context, args: unknown, agent?: Agent & { session: Session }): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'describe_image',
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/** The canonical description value of a successful call. */
function descriptionOf(result: ToolExecutionResult): string {
  if (result.isError) throw new Error('expected success')
  return (result.value as { description: string }).description
}

/** The failure message of a failed call. */
function failureOf(result: ToolExecutionResult): string {
  if (!result.isError) throw new Error('expected failure')
  return result.error.message
}

async function setup(overrides: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, overrides)
  return ctx
}

describe('describe_image schema', () => {
  it('declares the attachmentId|path source pair and a description output', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'describe_image')
    expect(schema).toBeDefined()
    const properties = (schema!.parameters as { properties: Record<string, unknown> }).properties
    expect(Object.keys(properties)).toEqual(['attachmentId', 'path', 'prompt', 'maxTokens'])
    const definition = ctx.tools.get('describe_image')
    const output = definition!.output.schema as { properties: Record<string, unknown> }
    expect(Object.keys(output.properties)).toEqual(['description'])
  })

  it('rejects a call naming neither or both sources at execution time', async () => {
    const ctx = await setup()
    const neither = await callReadImage(ctx, {})
    expect(neither.isError).toBe(true)
    expect(failureOf(neither)).toMatch(/exactly one of attachmentId and path/)
    const both = await callReadImage(ctx, { attachmentId: 'x', path: '/tmp/a.png' })
    expect(both.isError).toBe(true)
    expect(failureOf(both)).toMatch(/exactly one of attachmentId and path/)
  })
})

describe('describe_image path source', () => {
  it('reads a disk image and returns the vision description', async () => {
    const dir = await scratch()
    const file = join(dir, 'qr.png')
    await writeFile(file, PNG)
    const server = await mockVisionServer([{ body: JSON.stringify({ choices: [{ message: { content: 'a QR code' } }] }) }])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1`, timeoutMs: 5_000 })

    const result = await callReadImage(ctx, { path: file, prompt: 'what is this' })

    expect(result.isError).toBe(false)
    expect(descriptionOf(result)).toBe('a QR code')
    expect(server.paths).toEqual(['/v1/chat/completions'])
    expect(server.headers[0]?.authorization).toBe('Bearer test-key')
    const body = server.bodies[0] as {
      model: string
      messages: { content: Array<{ type: string; image_url?: { url: string }; text?: string }> }[]
      max_tokens: number
    }
    expect(body.model).toBe('mimo-v2.5')
    expect(body.max_tokens).toBe(1024)
    const parts = body.messages[0]?.content
    expect(parts?.[0]).toMatchObject({ type: 'text', text: 'what is this' })
    expect(parts?.[1]).toMatchObject({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } })
  })

  it('rejects an unknown image extension before any request', async () => {
    const dir = await scratch()
    const file = join(dir, 'qr.txt')
    await writeFile(file, 'not an image')
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup()

    const result = await callReadImage(ctx, { path: file })
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/cannot determine the image type/)
  })

  it('rejects a media type outside the allowed set', async () => {
    const dir = await scratch()
    const file = join(dir, 'qr.bmp')
    await writeFile(file, PNG)
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ allowedMediaTypes: ['image/png'] })

    const result = await callReadImage(ctx, { path: file })
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/unsupported image type "image\/bmp"/)
  })

  it('rejects an oversized image before any request', async () => {
    const dir = await scratch()
    const file = join(dir, 'qr.png')
    await writeFile(file, PNG)
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ maxBytes: 1 })

    const result = await callReadImage(ctx, { path: file })
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/over the 1-byte limit/)
  })
})

describe('describe_image attachmentId source', () => {
  it('resolves a hint-referenced attachment from the session log', async () => {
    const agent = agentWithSession('hint')
    attachHint(agent, QR_REF)
    const server = await mockVisionServer([{ body: JSON.stringify({ choices: [{ message: { content: 'it is a QR code' } }] }) }])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })
    await ctx.plugin(fixtureStore({ ref: QR_REF, data: PNG }))

    const result = await callReadImage(ctx, { attachmentId: String(QR_REF.attachmentId) }, agent)

    expect(result.isError).toBe(false)
    expect(descriptionOf(result)).toBe('it is a QR code')
  })

  it('resolves an image block referenced attachment (vision-model session)', async () => {
    const agent = agentWithSession('vision')
    attachImageBlock(agent, QR_REF)
    const server = await mockVisionServer([{ body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })
    await ctx.plugin(fixtureStore({ ref: QR_REF, data: PNG }))

    const result = await callReadImage(ctx, { attachmentId: String(QR_REF.attachmentId) }, agent)

    expect(result.isError).toBe(false)
    expect(server.paths).toHaveLength(1)
  })

  it('resolves an attachment nested inside a tool-result block', async () => {
    const agent = agentWithSession('nested')
    agent.session.append('user/message', createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: CallId('tc-1'),
        content: [{ type: 'image', attachment: QR_REF }],
      }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const server = await mockVisionServer([{ body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })
    await ctx.plugin(fixtureStore({ ref: QR_REF, data: PNG }))

    const result = await callReadImage(ctx, { attachmentId: String(QR_REF.attachmentId) }, agent)

    expect(result.isError).toBe(false)
    expect(server.paths).toHaveLength(1)
  })

  it('resolves an attachment from an assistant-message carrier', async () => {
    const agent = agentWithSession('carrier')
    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'image', attachment: QR_REF }],
        source: { provider: 'mimo', model: 'mimo-v2.5' },
      }),
    }, { surfaceOp: 'append' })
    const server = await mockVisionServer([{ body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })
    await ctx.plugin(fixtureStore({ ref: QR_REF, data: PNG }))

    const result = await callReadImage(ctx, { attachmentId: String(QR_REF.attachmentId) }, agent)

    expect(result.isError).toBe(false)
    expect(server.paths).toHaveLength(1)
  })

  it('resolves an attachment from an inbox-splice inserted carrier', async () => {
    const agent = agentWithSession('spliced')
    agent.session.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: MessageId('inserted-1'), role: 'user', content: [{ type: 'image', attachment: QR_REF }], source: { kind: 'user' } }],
    })
    const server = await mockVisionServer([{ body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })
    await ctx.plugin(fixtureStore({ ref: QR_REF, data: PNG }))

    const result = await callReadImage(ctx, { attachmentId: String(QR_REF.attachmentId) }, agent)

    expect(result.isError).toBe(false)
    expect(server.paths).toHaveLength(1)
  })

  it('skips non-object content entries while scanning', async () => {
    const agent = agentWithSession('mixed')
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'plain' }, 'string-entry' as never],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const server = await mockVisionServer([{ body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })
    await ctx.plugin(fixtureStore({ ref: QR_REF, data: PNG }))

    const result = await callReadImage(ctx, { attachmentId: String(QR_REF.attachmentId) }, agent)

    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/not referenced by this session/)
  })

  it('rejects attachmentId when no attachment service is mounted', async () => {
    const agent = agentWithSession('no-store')
    attachHint(agent, QR_REF)
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup()

    const result = await callReadImage(ctx, { attachmentId: String(QR_REF.attachmentId) }, agent)
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/no attachment service is mounted/)
  })

  it('ignores a malformed image block whose attachment is not a reference', async () => {
    const agent = agentWithSession('malformed')
    agent.session.append('user/message', createUserMessage({
      content: [
        { type: 'image', attachment: 'not-a-ref' } as never,
        { type: 'image', attachment: null } as never,
        { type: 'text', text: 42 } as never,
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const server = await mockVisionServer([])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })
    await ctx.plugin(fixtureStore({ ref: QR_REF, data: PNG }))

    const result = await callReadImage(ctx, { attachmentId: String(QR_REF.attachmentId) }, agent)
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/not referenced by this session/)
  })

  it('keeps scanning past a tool-result without a matching image', async () => {
    const agent = agentWithSession('no-match')
    agent.session.append('user/message', createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: CallId('tc-2'),
        content: [{ type: 'text', text: 'no image here' }],
      }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const server = await mockVisionServer([])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })
    await ctx.plugin(fixtureStore({ ref: QR_REF, data: PNG }))

    const result = await callReadImage(ctx, { attachmentId: String(QR_REF.attachmentId) }, agent)
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/not referenced by this session/)
  })

  it('keeps scanning past an inserted carrier without a matching image', async () => {
    const agent = agentWithSession('no-splice')
    agent.session.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: MessageId('inserted-2'), role: 'user', content: [{ type: 'text', text: 'plain' }], source: { kind: 'user' } }],
    })
    const server = await mockVisionServer([])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })
    await ctx.plugin(fixtureStore({ ref: QR_REF, data: PNG }))

    const result = await callReadImage(ctx, { attachmentId: String(QR_REF.attachmentId) }, agent)
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/not referenced by this session/)
  })

  it('keeps scanning past a hint carrying a different attachment id', async () => {
    const agent = agentWithSession('other-id')
    const other: ImageAttachmentRef = { ...QR_REF, attachmentId: AttachmentId(`sha256:${'f'.repeat(64)}`) }
    attachHint(agent, other)
    const server = await mockVisionServer([])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })
    await ctx.plugin(fixtureStore({ ref: QR_REF, data: PNG }))

    const result = await callReadImage(ctx, { attachmentId: String(QR_REF.attachmentId) }, agent)
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/not referenced by this session/)
  })

  it('keeps scanning past an image block carrying a different attachment id', async () => {
    const agent = agentWithSession('other-image')
    const other: ImageAttachmentRef = { ...QR_REF, attachmentId: AttachmentId(`sha256:${'f'.repeat(64)}`) }
    attachImageBlock(agent, other)
    const server = await mockVisionServer([])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })
    await ctx.plugin(fixtureStore({ ref: QR_REF, data: PNG }))

    const result = await callReadImage(ctx, { attachmentId: String(QR_REF.attachmentId) }, agent)
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/not referenced by this session/)
  })

  it('rejects an attachment not referenced by the session', async () => {
    const agent = agentWithSession('empty')
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup()
    await ctx.plugin(fixtureStore({ ref: QR_REF, data: PNG }))

    const result = await callReadImage(ctx, { attachmentId: String(QR_REF.attachmentId) }, agent)
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/not referenced by this session/)
  })

  it('rejects attachmentId without an owning agent session', async () => {
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup()
    const result = await callReadImage(ctx, { attachmentId: 'x' })
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/requires an owning agent session/)
  })
})

describe('describe_image credentials and endpoint', () => {
  it('resolves the key through the credentials seam when mounted', async () => {
    const dir = await scratch()
    const file = join(dir, 'qr.png')
    await writeFile(file, PNG)
    const server = await mockVisionServer([{ body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }])
    const ctx = await setup({ baseURL: `${server.url}/v1` })
    class Credentials {
      async resolve(): Promise<{ value: string }> { return { value: 'seam-key' } }
    }
    ctx.provide('credentials', new Credentials())

    const result = await callReadImage(ctx, { path: file })
    expect(result.isError).toBe(false)
    expect(server.headers[0]?.authorization).toBe('Bearer seam-key')
  })

  it('fails loud when the credential reference resolves to nothing', async () => {
    const dir = await scratch()
    const file = join(dir, 'qr.png')
    await writeFile(file, PNG)
    const ctx = await setup()

    const result = await callReadImage(ctx, { path: file })
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/no credential for MIMO_API_KEY/)
  })

  it('surfaces a non-2xx endpoint answer with the body excerpt', async () => {
    const dir = await scratch()
    const file = join(dir, 'qr.png')
    await writeFile(file, PNG)
    const server = await mockVisionServer([{ status: 401, body: JSON.stringify({ message: 'Invalid API Key' }) }])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })

    const result = await callReadImage(ctx, { path: file })
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/401/)
    expect(failureOf(result)).toMatch(/Invalid API Key/)
  })

  it('rejects an empty description', async () => {
    const dir = await scratch()
    const file = join(dir, 'qr.png')
    await writeFile(file, PNG)
    const server = await mockVisionServer([{ body: JSON.stringify({ choices: [{ message: { content: null } }] }) }])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })

    const result = await callReadImage(ctx, { path: file })
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/returned no description/)
  })

  it('aborts the request when the endpoint exceeds the timeout', async () => {
    const dir = await scratch()
    const file = join(dir, 'qr.png')
    await writeFile(file, PNG)
    const server = await mockVisionServer([{ body: '{}', delayMs: 500 }])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1`, timeoutMs: 50 })

    const result = await callReadImage(ctx, { path: file })
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toMatch(/timed out/)
  })

  it('honors a caller-provided maxTokens', async () => {
    const dir = await scratch()
    const file = join(dir, 'qr.png')
    await writeFile(file, PNG)
    const server = await mockVisionServer([{ body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })

    const result = await callReadImage(ctx, { path: file, maxTokens: 64 })
    expect(result.isError).toBe(false)
    expect((server.bodies[0] as { max_tokens: number }).max_tokens).toBe(64)
  })

  it('reports a non-2xx answer with an empty body without a trailing excerpt', async () => {
    const dir = await scratch()
    const file = join(dir, 'qr.png')
    await writeFile(file, PNG)
    const server = await mockVisionServer([{ status: 503, body: '' }])
    vi.stubEnv('MIMO_API_KEY', 'test-key')
    const ctx = await setup({ baseURL: `${server.url}/v1` })

    const result = await callReadImage(ctx, { path: file })
    expect(result.isError).toBe(true)
    expect(failureOf(result)).toBe('describe_image: vision endpoint answered 503')
  })

  it('renders a generic read card for the call', async () => {
    const ctx = await setup()
    const definition = ctx.tools.get('describe_image')
    expect(definition?.presentCall?.({ attachmentId: 'x' })).toEqual({
      card: 'generic',
      title: 'Read image',
      kind: 'read',
      rawInput: { attachmentId: 'x' },
    })
  })
})
