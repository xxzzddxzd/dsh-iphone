import { expect, it } from 'vitest'
import { parseGifOptions, GifParameterError } from '../src/gif-options.ts'

it('uses smooth defaults only when the user has not specified parameters', () => {
 expect(parseGifOptions('把这张图做成 GIF')).toEqual({frameCount:16,frameDurationMs:100})
 expect(parseGifOptions('做成 GIF，12 帧，每帧 100 毫秒')).toEqual({frameCount:12,frameDurationMs:100})
 expect(parseGifOptions('GIF，帧数：8，帧间隔 250ms')).toEqual({frameCount:8,frameDurationMs:250})
 expect(parseGifOptions('gif frame_count=2, frame_duration_ms=20')).toEqual({frameCount:2,frameDurationMs:20})
 expect(parseGifOptions('做成 GIF，十六帧，每帧一百毫秒')).toEqual({frameCount:16,frameDurationMs:100})
 expect(parseGifOptions('ＧＩＦ，１２帧，每一帧２００毫秒')).toEqual({frameCount:12,frameDurationMs:200})
 expect(parseGifOptions('GIF 4 frames, 100 ms per frame')).toEqual({frameCount:4,frameDurationMs:100})
})
it('refuses out-of-range, noninteger, conflicting and fps parameters before any request', () => {
 for (const prompt of ['GIF 1帧', 'GIF 17帧', 'GIF 2.5帧', 'GIF -2帧', 'GIF 每帧 19毫秒', 'GIF 每帧 2001ms', 'GIF 4帧和8帧', 'GIF 24fps', 'GIF 帧率24', 'GIF 12 frames per second']) {
  expect(() => parseGifOptions(prompt)).toThrow(GifParameterError)
 }
})
