import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
export function imageMediaType(data: Uint8Array): ImageMediaType | undefined {
 if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 13 && data[5] === 10 && data[6] === 26 && data[7] === 10) return 'image/png'
 if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
 if (data.length >= 12 && String.fromCharCode(...data.subarray(0,4)) === 'RIFF' && String.fromCharCode(...data.subarray(8,12)) === 'WEBP') return 'image/webp'
 return undefined
}
