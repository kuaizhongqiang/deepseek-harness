/**
 * Real-key end-to-end: the REAL agent loop with a REAL text-only main model
 * (DeepSeek V4 flash) receives an image-ref hint and calls the REAL describe_image
 * tool, which asks the REAL vision endpoint (Xiaomi MiMo) to describe a QR
 * fixture; DeepSeek then answers from that description. Self-skips without
 * both DEEPSEEK_API_KEY and MIMO_API_KEY.
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore, imageRefHint } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as ToolDescribeImage from '@deepseek-ai/dsh-tool-describe-image'

const deepSeekKey = process.env.DEEPSEEK_API_KEY
const mimoKey = process.env.MIMO_API_KEY

/** A read-only attachment store serving the QR fixture. */
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

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe.skipIf(deepSeekKey === undefined || mimoKey === undefined)(
  'describe_image through the real loop and vision endpoint',
  () => {
    it('DeepSeek calls describe_image on an image hint and answers from the MiMo description', async () => {
      const data = new Uint8Array(await readFile(
        new URL('../../../../assets/community-wecom-survey.png', import.meta.url),
      ))
      const ref: ImageAttachmentRef = {
        attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
        mediaType: 'image/png',
        bytes: data.byteLength,
        width: 256,
        height: 256,
        name: 'qr.png',
      }
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(LlmPiAi, {
        providers: {
          // The product's main model: a text-only OpenAI-compatible route.
          'deepseek-official': {
            apiKeyEnv: 'DEEPSEEK_API_KEY',
            api: 'openai-completions',
            baseURL: 'https://api.deepseek.com/v1',
            models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000, maxTokens: 8192 }],
          },
        },
      })
      await ctx.plugin(ToolDescribeImage, {})
      await ctx.plugin(fixtureStore({ ref, data }))

      const agent = ctx.agentLoop.create(SessionId('e2e-describe-image'), {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
      // The api-proxy conversion path emits exactly this hint text for a
      // text-only session model; feeding it directly exercises the same input
      // the product builds.
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: `${imageRefHint(ref)} 请用 describe_image 工具查看这张图片，然后回答图中显示的是什么机器可读符号。`,
        }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)

      const log = agent.session.events
      const call = log.findLast(event => event.type === 'tool/call')
      expect(call?.type === 'tool/call' && call.data.name).toBe('describe_image')
      const result = log.findLast(event => event.type === 'tool/result')
      const resultText = result?.type === 'tool/result'
        ? result.data.message.content
          .flatMap(block => block.type === 'tool-result' ? block.content : [])
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        : ''
      expect(resultText).toMatch(/qr|二维码/i)
      const reply = log.findLast(event => event.type === 'assistant/message')
      const replyText = reply?.type === 'assistant/message'
        ? reply.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        : ''
      expect(replyText).toMatch(/qr|二维码/i)

      await ctx.fiber.dispose()
    })
  },
)
