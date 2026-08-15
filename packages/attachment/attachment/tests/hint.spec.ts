import { describe, expect, it } from 'vitest'
import { AttachmentId } from '../src/brand.ts'
import { imageRefHint, parseImageRefHint } from '../src/hint.ts'
import type { ImageAttachmentRef } from '../src/types.ts'

const REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 30_477,
  width: 512,
  height: 384,
  name: 'qr.png',
}

describe('image-ref hint', () => {
  it('round-trips a named reference', () => {
    const hint = imageRefHint(REF)
    expect(hint.startsWith(`[图片附件 sha256:${'a'.repeat(64)} (image/png, 512×384, 30477B, "qr.png")]`)).toBe(true)
    expect(hint).toContain('describe_image')
    expect(parseImageRefHint(hint)).toEqual(REF)
  })

  it('round-trips an unnamed reference', () => {
    const { name: _name, ...unnamed } = REF
    const parsed = parseImageRefHint(imageRefHint(unnamed))
    expect(parsed).toEqual(unnamed)
    expect(parsed?.name).toBeUndefined()
  })

  it('parses a name containing quotes and escapes', () => {
    const ref = { ...REF, name: 'a "quoted" \\ name.png' }
    expect(parseImageRefHint(imageRefHint(ref))).toEqual(ref)
  })

  it('returns undefined for text without a hint', () => {
    expect(parseImageRefHint('hello')).toBeUndefined()
    expect(parseImageRefHint('')).toBeUndefined()
    expect(parseImageRefHint('[图片附件 nope')).toBeUndefined()
  })

  it('treats a malformed name as no hint at all (the format is owned, not guessed)', () => {
    const hint = imageRefHint(REF).replace('"qr.png"', 'broken')
    expect(parseImageRefHint(hint)).toBeUndefined()
  })

  it('drops a name that is valid regex but invalid JSON, keeping the other fields', () => {
    // `\\.` matches `\x`, which JSON.parse rejects; the reference still parses.
    const parsed = parseImageRefHint(`[图片附件 sha256:${'a'.repeat(64)} (image/png, 512×384, 30477B, "\\x")]`)
    expect(parsed?.attachmentId).toEqual(REF.attachmentId)
    expect(parsed?.width).toBe(512)
    expect(parsed?.name).toBeUndefined()
  })
})
