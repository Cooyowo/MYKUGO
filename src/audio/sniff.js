'use strict';

/**
 * 明文音频的真实格式嗅探。
 *
 * 为什么必须嗅探：.kgg 只是「加密外壳」，里面可能是 MP3，也可能是 FLAC/OGG。
 * 直接按扩展名猜会产出打不开的文件，所以一律看解密后的头几个字节。
 */

/** 判断是否为 MP3 帧同步头（11 位全 1）。 */
function isMpegFrameSync(b0, b1) {
  return b0 === 0xff && (b1 & 0xe0) === 0xe0;
}

/**
 * @param {Buffer} probe 明文音频的前若干字节（至少 4 字节，建议 16 字节）
 * @returns {string} mp3 / flac / ogg / wav / m4a / bin（bin = 无法识别）
 */
function detect(probe) {
  if (!Buffer.isBuffer(probe) || probe.length < 4) return 'bin';

  // ID3v2 标签开头的 MP3
  if (probe[0] === 0x49 && probe[1] === 0x44 && probe[2] === 0x33) return 'mp3';
  // fLaC
  if (probe[0] === 0x66 && probe[1] === 0x4c && probe[2] === 0x61 && probe[3] === 0x43) return 'flac';
  // OggS
  if (probe[0] === 0x4f && probe[1] === 0x67 && probe[2] === 0x67 && probe[3] === 0x53) return 'ogg';
  // RIFF (WAV)
  if (probe[0] === 0x52 && probe[1] === 0x49 && probe[2] === 0x46 && probe[3] === 0x46) return 'wav';
  // 直接以帧同步开头的 MP3
  if (isMpegFrameSync(probe[0], probe[1])) return 'mp3';
  // offset 4 处有 'ftyp' 的 M4A/MP4
  if (
    probe.length >= 8 &&
    probe[4] === 0x66 && probe[5] === 0x74 && probe[6] === 0x79 && probe[7] === 0x70
  ) {
    return 'm4a';
  }

  return 'bin';
}

/** 无损格式判断（用于决定是否需要转码）。 */
function isLossless(format) {
  return format === 'flac' || format === 'wav';
}

module.exports = { detect, isLossless, isMpegFrameSync };
