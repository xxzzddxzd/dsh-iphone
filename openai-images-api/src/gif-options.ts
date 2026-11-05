/** Validated parameters for one explicit animated GIF request. */
export interface GifOptions {
  frameCount: number
  frameDurationMs: number
}

export const DEFAULT_GIF_OPTIONS: Readonly<GifOptions> = Object.freeze({ frameCount: 16, frameDurationMs: 100 })

/** A safe user-facing validation error: it never contains the input prompt. */
export class GifParameterError extends Error {
  constructor(message: string) { super(message); this.name = 'GifParameterError' }
}

const DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
const NUMBER = '([+-]?[0-9]+(?:\\.[0-9]+)?|[零〇一二两三四五六七八九十百千]+)'

function numberValue(text: string): number {
  if (/^[+-]?[0-9]+(?:\.[0-9]+)?$/u.test(text)) return Number(text)
  if (![...text].some(character => character in UNITS)) {
    const decimal = [...text].map(character => DIGITS[character]).join('')
    return Number(decimal)
  }
  let total = 0, pending = 0, previousUnit = 10000
  for (const character of text) {
    if (character in DIGITS) { pending = DIGITS[character]!; continue }
    const unit = UNITS[character]
    if (unit === undefined || unit >= previousUnit) return Number.NaN
    total += (pending || 1) * unit
    pending = 0; previousUnit = unit
  }
  return total + pending
}

function values(text: string, expressions: readonly RegExp[], rejectFrameReferences = false): number[] {
  const found: number[] = []
  for (const expression of expressions) {
    for (const match of text.matchAll(expression)) {
      // “第一帧”, “最后一帧” and “相邻两帧” refer to existing frames,
      // not the total count; “每一帧” similarly describes per-frame timing.
      if (rejectFrameReferences && match.index !== undefined) {
        const prefix = text.slice(Math.max(0, match.index - 32), match.index)
        if (/(?:每|第|最后|相邻|连续|前|后|首|末|头|尾|任意|其中)\s*$/u.test(prefix)
          || /\b(?:each|every|first|last|next|previous|prior|adjacent|consecutive)\s+$/iu.test(prefix)) continue
      }
      found.push(numberValue(match[1]!))
    }
  }
  return found
}

function checked(values: number[], fallback: number, min: number, max: number, label: string): number {
  if (values.length === 0) return fallback
  if (values.some(value => !Number.isInteger(value) || value < min || value > max)) {
    throw new GifParameterError(`GIF ${label}必须是 ${min}–${max} 的整数；请求未发送。`)
  }
  if (values.some(value => value !== values[0])) throw new GifParameterError(`GIF ${label}指定了多个不同数值，请只填写一个；请求未发送。`)
  return values[0]!
}

/** Parse explicit, unambiguous total frames and milliseconds per frame. */
export function parseGifOptions(raw: string): GifOptions {
  const text = raw.normalize('NFKC')
  if (new RegExp(`${NUMBER}\\s*(?:fps|帧\\s*/\\s*秒|帧每秒|frames?\\s+per\\s+second)|(?:帧率|fps)\\s*[:=为是]?\\s*${NUMBER}`, 'iu').test(text)) {
    throw new GifParameterError('请用“每帧多少毫秒”指定 GIF 速度；请求未发送。')
  }
  const frames = values(text, [
    new RegExp(`(?:帧数|frame[_\\s-]*count)\\s*[:=为是]?\\s*${NUMBER}`, 'giu'),
    new RegExp(`${NUMBER}\\s*(?:帧(?!率)|frames?\\b)`, 'giu'),
  ], true)
  const duration = values(text, [
    new RegExp(`(?:每(?:一)?帧|帧(?:间隔|时长|持续时间)|frame[_\\s-]*duration(?:[_\\s-]*ms)?)\\s*[:=为是]?\\s*${NUMBER}\\s*(?:毫秒|ms|milliseconds?)?`, 'giu'),
    new RegExp(`${NUMBER}\\s*(?:毫秒|ms|milliseconds?)\\s*(?:/\\s*帧|每帧|一帧|per\\s+frame)`, 'giu'),
  ])
  return {
    frameCount: checked(frames, DEFAULT_GIF_OPTIONS.frameCount, 2, 16, '帧数'),
    frameDurationMs: checked(duration, DEFAULT_GIF_OPTIONS.frameDurationMs, 20, 2000, '每帧时长（毫秒）'),
  }
}

/** Guard direct callers as well as the natural-language parser. */
export function validateGifOptions(options: GifOptions): GifOptions {
  return {
    frameCount: checked([options.frameCount], DEFAULT_GIF_OPTIONS.frameCount, 2, 16, '帧数'),
    frameDurationMs: checked([options.frameDurationMs], DEFAULT_GIF_OPTIONS.frameDurationMs, 20, 2000, '每帧时长（毫秒）'),
  }
}
