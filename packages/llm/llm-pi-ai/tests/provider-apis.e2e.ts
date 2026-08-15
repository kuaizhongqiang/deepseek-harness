import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiReplayState } from '../src/replay.ts'
import { assemble, type AssembledResult } from './assemble.ts'

interface ProviderCase {
  provider: 'openai' | 'anthropic' | 'mimo'
  api: 'openai-responses' | 'anthropic-messages' | 'openai-completions'
  model: string
  apiKey?: string
  apiKeyEnv?: string
  baseURL?: string
  headers?: Record<string, string>
  /** Whether the case exercises the image-input path (a vision-capable model). */
  vision?: boolean
  /** The hand-declared model catalog for a route pi-ai does not ship. */
  models?: readonly { id: string; name?: string; input?: readonly ('text' | 'image')[]; contextWindow?: number; maxTokens?: number }[]
  /**
   * Whether the route is served by the harness-builtin catalog (`./src/builtin.ts`)
   * rather than declared in the profile; the profile then carries only the
   * credential and an optional endpoint override.
   */
  builtin?: boolean
}

const openAIBaseURL = process.env.DSH_PI_AI_OPENAI_BASE_URL
const azureOpenAIKey = process.env.AZURE_OPENAI_API_KEY
// Strictly ANTHROPIC_*: the DeepSeek endpoint does not serve the anthropic-messages
// protocol, so falling back to DEEPSEEK_API_KEY turns the keyless skip into a 404.
const anthropicApiKey = process.env.ANTHROPIC_API_KEY
const anthropicBaseURL = process.env.DSH_PI_AI_ANTHROPIC_BASE_URL

const providerCases: ProviderCase[] = [
  {
    provider: 'openai',
    api: 'openai-responses',
    model: process.env.DSH_PI_AI_OPENAI_MODEL ?? 'gpt-5.5',
    ...azureOpenAIKey
      ? { apiKey: azureOpenAIKey, headers: { 'api-key': azureOpenAIKey, Authorization: '' } }
      : {},
    ...openAIBaseURL ? { baseURL: openAIBaseURL } : {},
  },
  {
    provider: 'anthropic',
    api: 'anthropic-messages',
    model: process.env.DSH_PI_AI_ANTHROPIC_MODEL ?? 'claude-opus-4-8',
    ...anthropicApiKey === undefined ? {} : { apiKey: anthropicApiKey },
    ...anthropicBaseURL === undefined ? {} : { baseURL: anthropicBaseURL },
    vision: true,
  },
  {
    provider: 'mimo',
    api: 'openai-completions',
    model: process.env.DSH_PI_AI_MIMO_MODEL ?? 'mimo-v2.5',
    // The harness resolves the key through its own credential seam; the case
    // only names the reference, and the suite self-skips while it is unset.
    apiKeyEnv: 'MIMO_API_KEY',
    vision: true,
    // A harness-builtin route (packages/llm/llm-pi-ai/src/builtin.ts): the
    // profile carries only the credential, proving the shipped catalog serves
    // the endpoint, protocol, and model facts.
    builtin: true,
  },
]

const contexts: Context[] = []

/** The provider profile one case drives: a builtin route carries only the credential. */
function profileOf(profile: ProviderCase): Record<string, unknown> {
  if (profile.builtin === true) {
    return {
      ...profile.apiKey === undefined ? {} : { apiKey: profile.apiKey },
      ...profile.apiKeyEnv === undefined ? {} : { apiKeyEnv: profile.apiKeyEnv },
      ...profile.baseURL === undefined ? {} : { baseURL: profile.baseURL },
    }
  }
  return {
    api: profile.api,
    ...profile.apiKey === undefined ? {} : { apiKey: profile.apiKey },
    ...profile.apiKeyEnv === undefined ? {} : { apiKeyEnv: profile.apiKeyEnv },
    ...profile.baseURL === undefined ? {} : { baseURL: profile.baseURL },
    ...profile.headers === undefined ? {} : { headers: profile.headers },
    ...profile.models === undefined ? {} : { models: profile.models },
  }
}

async function harness(image?: StoredImageAttachment): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: Object.fromEntries(providerCases.map(profile => [profile.provider, profileOf(profile)])),
  })
  if (image !== undefined) {
    const fixture = image
    class E2eAttachmentStore extends AttachmentStore {
      readonly imageLimits: ImageAttachmentLimits = {
        maxImageBytes: fixture.data.byteLength,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: fixture.data.byteLength,
        maxImagePixels: fixture.ref.width * fixture.ref.height,
        mediaTypes: [fixture.ref.mediaType],
      }

      validateImage(_input: SaveImageAttachment): Promise<void> {
        return Promise.reject(new Error('e2e attachment fixture is read-only'))
      }

      saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
        return Promise.reject(new Error('e2e attachment fixture is read-only'))
      }

      readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
        if (ref.attachmentId !== fixture.ref.attachmentId) {
          return Promise.reject(new Error('unknown e2e attachment fixture'))
        }
        return Promise.resolve(fixture)
      }
    }
    await ctx.plugin(E2eAttachmentStore)
  }
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function ask(text: string): Message[] {
  return [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })]
}

function textOf(result: AssembledResult): string {
  return result.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function expectFinish(result: AssembledResult, expected: 'stop' | 'tool-calls'): void {
  if (result.finish.kind === 'error') {
    throw new Error(`provider request failed (${result.finish.failure.code}): ${result.finish.failure.message}`)
  }
  expect(result.finish.kind).toBe(expected)
}

function expectNativeReplay(result: AssembledResult, profile: ProviderCase): PiAiReplayState {
  const replayState = result.message.source.kind === 'model'
    ? result.message.source.replayState
    : undefined
  expect(replayState).toMatchObject({
    kind: 'pi-ai',
    version: 1,
    api: profile.api,
    provider: profile.provider,
    model: profile.model,
  })
  return replayState as PiAiReplayState
}

const lookupTool: ToolSchema = {
  name: 'lookup_code',
  description: 'Look up the word represented by a short code.',
  parameters: {
    type: 'object',
    properties: { code: { type: 'string', description: 'The code to look up.' } },
    required: ['code'],
  },
}

for (const profile of providerCases) {
  // A case skips when it has no usable credential: `apiKey` carries the value
  // for cases that read it directly, while `apiKeyEnv` names a reference the
  // harness resolves, which is usable only while the environment holds it.
  describe.skipIf(
    profile.apiKey === undefined
    && (profile.apiKeyEnv === undefined || process.env[profile.apiKeyEnv] === undefined),
  )(
    `llm-pi-ai ${profile.provider} e2e (${profile.api})`,
    () => {
      it('streams text with usage and native replay metadata', async () => {
        const ctx = await harness()
        const result = await assemble(ctx, {
          provider: profile.provider,
          model: profile.model,
          messages: ask('Reply with exactly the word: pong'),
          maxTokens: 1024,
        })

        expectFinish(result, 'stop')
        expect(textOf(result).toLowerCase()).toContain('pong')
        expect(result.usage?.inputTokens).toBeGreaterThan(0)
        expect(result.usage?.outputTokens).toBeGreaterThan(0)
        expect(expectNativeReplay(result, profile).stopReason).toBe('stop')
      })

      it('round-trips a tool call with provider-native replay metadata', async () => {
        const ctx = await harness()
        const prompt = ask('Use lookup_code with code "blue". Do not answer without calling the tool.')
        const first = await assemble(ctx, {
          provider: profile.provider,
          model: profile.model,
          messages: prompt,
          tools: [lookupTool],
          maxTokens: 2048,
        })

        expectFinish(first, 'tool-calls')
        const call = first.message.content.find(block => block.type === 'tool-call')
        expect(call).toBeDefined()
        expect(call!.name).toBe('lookup_code')
        expect(JSON.parse(call!.arguments)).toMatchObject({ code: 'blue' })
        expect(expectNativeReplay(first, profile).stopReason).toBe('toolUse')

        const second = await assemble(ctx, {
          provider: profile.provider,
          model: profile.model,
          messages: [
            ...prompt,
            first.message,
            createUserMessage({
              content: [{
                type: 'tool-result',
                toolCallId: CallId(call!.id),
                content: [{ type: 'text', text: 'The code blue means ocean.' }],
              }],
              source: { kind: 'plugin', plugin: 'test' },
            }),
          ],
          tools: [lookupTool],
          maxTokens: 2048,
        })

        expectFinish(second, 'stop')
        expect(textOf(second).toLowerCase()).toContain('ocean')
        expect(expectNativeReplay(second, profile).stopReason).toBe('stop')
      })

      if (profile.vision === true) {
        it('sends a real image through the authenticated visual path', async () => {
          const data = new Uint8Array(await readFile(
            new URL('../../../../assets/community-wecom-survey.png', import.meta.url),
          ))
          const ref: ImageAttachmentRef = {
            attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
            mediaType: 'image/png',
            bytes: data.byteLength,
            width: 256,
            height: 256,
            name: 'qr-code.png',
          }
          const ctx = await harness({ ref, data })
          const result = await assemble(ctx, {
            provider: profile.provider,
            model: profile.model,
            messages: [createUserMessage({
              content: [
                {
                  type: 'text',
                  text: 'What type of machine-readable symbol is shown in the attached image? Reply with exactly: QR code',
                },
                { type: 'image', attachment: ref },
              ],
              source: { kind: 'plugin', plugin: 'test' },
            })],
            maxTokens: 256,
          })

          expectFinish(result, 'stop')
          expect(textOf(result).toLowerCase()).toContain('qr code')
        })
      }
    },
  )
}
