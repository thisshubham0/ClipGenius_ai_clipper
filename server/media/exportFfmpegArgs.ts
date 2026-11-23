import type { ExportContainerFormat, ExportQuality } from '../../src/types/clipgenius';

export interface ContainerEncodingArgsOptions {
  containerFormat: ExportContainerFormat;
  quality: ExportQuality;
  hasAudio: boolean;
  fastPreview?: boolean;
}

/**
 * Wraps the final video output pad of a filter_complex graph with a single-pass
 * high-quality palettegen/paletteuse chain for crisp animated GIF exports.
 */
export function appendGifPaletteFilter(
  filterComplex: string,
  videoMapLabel: string
): { filterComplex: string; videoMap: string } {
  const rawLabel = videoMapLabel.replace(/^\[|\]$/g, '');
  const gifChain =
    `[${rawLabel}]fps=12,scale='min(480,iw)':-2:flags=lanczos,split[gif_a][gif_b];` +
    `[gif_a]palettegen=max_colors=192:stats_mode=diff[gif_pal];` +
    `[gif_b][gif_pal]paletteuse=dither=bayer:bayer_scale=3[vgif]`;
  return {
    filterComplex: `${filterComplex};${gifChain}`,
    videoMap: '[vgif]',
  };
}

/**
 * Returns deterministic, universally compatible FFmpeg 4.x+ output codec,
 * container, metadata-stripping, and faststart flags for each user-selected format.
 */
export function buildContainerEncodingArgs(
  options: ContainerEncodingArgsOptions
): string[] {
  const { containerFormat, quality, hasAudio, fastPreview = false } = options;

  // Strip weird source MKV/MP4 tags that can break QuickTime / Windows Media Player
  const commonBase = ['-map_metadata', '-1'];

  if (containerFormat === 'mp3') {
    return [
      ...commonBase,
      '-vn',
      '-c:a',
      'libmp3lame',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-b:a',
      '192k',
      '-f',
      'mp3',
    ];
  }

  if (containerFormat === 'gif') {
    return [...commonBase, '-an', '-loop', '0', '-f', 'gif'];
  }

  if (containerFormat === 'webm') {
    const crf = quality === '1080p' ? '30' : quality === '720p' ? '32' : '35';
    const args = [
      ...commonBase,
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      '0',
      '-crf',
      crf,
      '-deadline',
      'realtime',
      '-cpu-used',
      '6',
      '-row-mt',
      '1',
      '-pix_fmt',
      'yuv420p',
    ];
    if (hasAudio) {
      args.push('-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '128k');
    } else {
      args.push('-an');
    }
    args.push('-f', 'webm');
    return args;
  }

  // H.264 family: MP4, MOV, MKV
  const h264Preset = fastPreview
    ? 'ultrafast'
    : quality === '1080p'
      ? 'veryfast'
      : 'veryfast';
  const h264Crf = fastPreview
    ? '26'
    : quality === '1080p'
      ? '21'
      : quality === '720p'
        ? '23'
        : '25';

  const args: string[] = [
    ...commonBase,
    '-c:v',
    'libx264',
    '-profile:v',
    fastPreview ? 'main' : 'high',
    '-level:v',
    '4.1',
    '-preset',
    h264Preset,
    '-crf',
    h264Crf,
    '-pix_fmt',
    'yuv420p',
    '-vsync',
    'cfr',
  ];

  if (containerFormat === 'mp4' || containerFormat === 'mov') {
    // avc1 tag ensures 100% compatibility with QuickTime, macOS, iOS, Windows & browsers
    args.push('-tag:v', 'avc1');
  }

  if (hasAudio) {
    args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2', '-b:a', '192k');
  } else {
    args.push('-an');
  }

  if (containerFormat === 'mov') {
    args.push('-movflags', '+faststart', '-f', 'mov');
  } else if (containerFormat === 'mkv') {
    args.push('-f', 'matroska');
  } else {
    args.push('-movflags', '+faststart', '-f', 'mp4');
  }

  return args;
}
