/**
 * The text-hint format that carries an image attachment reference in a
 * text-only model request.
 *
 * When a prompt containing images lands on a text-only model (with the
 * `describe_image` tool mounted), `dsh-host-apiproxy` stores the images as durable
 * attachments and replaces each image block with one of these hints, so the
 * model request carries no image block and the reference stays reconstructable
 * from the session log. The format is owned here so the writer (api-proxy) and
 * the readers (`referencedImage` authorization and the `describe_image` tool) can
 * never drift.
 *
 * @module dsh-attachment/hint
 */

import type { ImageAttachmentRef } from './types.ts'

/**
 * Render a text hint that carries one durable image reference. The leading
 * bracket section is machine-parseable by {@link parseImageRefHint}; the
 * trailing instruction is free text the model reads.
 * @param ref - the durable reference to embed.
 * @returns the hint text.
 */
export function imageRefHint(ref: ImageAttachmentRef): string {
  const name = ref.name === undefined ? '' : `, ${JSON.stringify(ref.name)}`
  const bracket = `[图片附件 ${String(ref.attachmentId)} (${ref.mediaType}, ${ref.width}×${ref.height}, ${ref.bytes}B${name})]`
  return `${bracket} — 使用 describe_image 工具（参数 attachmentId=${String(ref.attachmentId)}）查看此图片`
}

/**
 * Parse the leading reference section of an image-attachment hint.
 * @param text - text possibly carrying an image-ref hint.
 * @returns the embedded reference, or `undefined` when the text is not a hint.
 */
export function parseImageRefHint(text: string): ImageAttachmentRef | undefined {
  const match = /^\[图片附件 ([^ (]+) \(([^,]+), (\d+)×(\d+), (\d+)B(?:, ("(?:[^"\\]|\\.)*"))?\)\]/.exec(text)
  if (match === null) return undefined
  // The pattern defines every group, so a successful match guarantees them.
  const id = match[1] as string
  const mediaType = match[2] as string
  const width = match[3] as string
  const height = match[4] as string
  const bytes = match[5] as string
  const nameJson = match[6]
  const ref: ImageAttachmentRef = {
    attachmentId: id as ImageAttachmentRef['attachmentId'],
    mediaType: mediaType as ImageAttachmentRef['mediaType'],
    width: Number(width),
    height: Number(height),
    bytes: Number(bytes),
  }
  if (nameJson !== undefined) {
    try {
      // The regex accepts any backslash escape, so a name can be valid regex
      // yet invalid JSON (e.g. `\x`); such a name is dropped, the rest stands.
      const parsed = JSON.parse(nameJson) as unknown
      if (typeof parsed === 'string') ref.name = parsed
    } catch {
      // An unparsable name leaves the reference unnamed; the other fields stand.
    }
  }
  return ref
}
