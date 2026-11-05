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

it('distinguishes total frame count from individual frames and adjacent-frame groups', () => {
 const prompt = '把这张图做成 16 帧的循环 GIF，每帧 60 毫秒。角色自然轻轻眨眼、轻微弹跳；特别注意动作连贯性，相邻帧的姿势和位移要平滑渐变，不要突跳、闪烁、变形或抖动，最后一帧自然衔接第一帧形成无缝循环。保持原图角色面容、蓝发、衣服、文字、构图和画风一致。'
 expect(parseGifOptions(prompt)).toEqual({ frameCount: 16, frameDurationMs: 60 })
 for (const text of [
  'GIF，12帧，第一帧与最后一帧相连',
  'GIF，12帧，要求第 1 帧和最后 1 帧衔接',
  'GIF，12帧，相邻两帧的变化要自然',
  'GIF，12帧，每一帧都保持角色一致',
  'GIF 12 frames, match the first 1 frame to the last 1 frame',
 ]) expect(parseGifOptions(text)).toEqual({ frameCount: 12, frameDurationMs: 100 })
 expect(parseGifOptions('GIF 2帧')).toEqual({ frameCount: 2, frameDurationMs: 100 })
 expect(() => parseGifOptions('GIF 17帧，第一帧衔接最后一帧')).toThrow(GifParameterError)
 expect(() => parseGifOptions('GIF 1帧，最后一帧衔接第一帧')).toThrow(GifParameterError)
 expect(() => parseGifOptions('GIF 4帧和8帧，最后一帧衔接第一帧')).toThrow(GifParameterError)
})
