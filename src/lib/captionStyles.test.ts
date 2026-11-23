import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCaptionTextOutlineShadow,
  getAssAlignment,
  getSafeCaptionLayoutMetrics,
  hexToRgba,
  mapFontFamilyToAss,
  resolveCaptionStyle,
  wrapCaptionWords,
} from './captionStyles';

test('resolveCaptionStyle resolves preset defaults and applies all custom overrides consistently', () => {
  const bold = resolveCaptionStyle({ captionStyle: 'bold_viral', captionOverrides: {} });
  assert.equal(bold.fontFamily, 'Outfit');
  assert.equal(bold.fontWeight, 800);
  assert.equal(bold.strokeWidthPx, 3);
  assert.equal(bold.backgroundOpacity, 0);
  assert.equal(bold.position, 'center');
  assert.equal(bold.uppercase, true);
  assert.equal(bold.animation, 'pop');

  const minimal = resolveCaptionStyle({ captionStyle: 'minimal', captionOverrides: {} });
  assert.equal(minimal.fontWeight, 500);
  assert.ok(minimal.backgroundOpacity >= 0.7);
  assert.equal(minimal.animation, 'fade');

  const custom = resolveCaptionStyle({
    captionStyle: 'modern_animated',
    captionOverrides: {
      fontFamily: 'JetBrains Mono',
      fontSizePx: 28,
      fontWeight: 800,
      primaryColor: '#FDE68A',
      highlightColor: '#22C55E',
      strokeColor: '#1E1B4B',
      strokeWidthPx: 3.5,
      backgroundColor: '#111827',
      backgroundOpacity: 0.8,
      textAlign: 'left',
      maxWordsPerLine: 4,
      position: 'top',
      uppercase: true,
      animation: 'karaoke',
    },
  });

  assert.equal(custom.fontFamily, 'JetBrains Mono');
  assert.equal(custom.fontSizePx, 28);
  assert.equal(custom.fontWeight, 800);
  assert.equal(custom.primaryColor, '#FDE68A');
  assert.equal(custom.highlightColor, '#22C55E');
  assert.equal(custom.strokeColor, '#1E1B4B');
  assert.equal(custom.strokeWidthPx, 3.5);
  assert.equal(custom.backgroundColor, '#111827');
  assert.equal(custom.backgroundOpacity, 0.8);
  assert.equal(custom.textAlign, 'left');
  assert.equal(custom.maxWordsPerLine, 4);
  assert.equal(custom.position, 'top');
  assert.equal(custom.uppercase, true);
  assert.equal(custom.animation, 'karaoke');
});

test('getSafeCaptionLayoutMetrics scales fonts safely for 9:16 and 16:9 without overflow', () => {
  const largeStyle = resolveCaptionStyle({
    captionStyle: 'bold_viral',
    captionOverrides: { fontSizePx: 32, maxWordsPerLine: 6 },
  });

  const portrait = getSafeCaptionLayoutMetrics('9:16', largeStyle);
  const landscape = getSafeCaptionLayoutMetrics('16:9', largeStyle);

  assert.ok(portrait.previewFontSizePx <= 21);
  assert.ok(landscape.previewFontSizePx <= 24);
  assert.ok(portrait.horizontalSafePct >= 7);
  assert.ok(landscape.horizontalSafePct >= 8);
  assert.ok(portrait.effectiveWordsPerCue <= 5);
  assert.equal(landscape.effectiveWordsPerCue, 6);
});

test('hexToRgba, outline shadow, wrapCaptionWords, ASS font mapping, and ASS alignment work accurately', () => {
  assert.equal(hexToRgba('#0B0D11', 0.75), 'rgba(11, 13, 17, 0.75)');
  assert.equal(hexToRgba('#000000', 0), 'transparent');

  const shadow = buildCaptionTextOutlineShadow('#FF0000', 2.5);
  assert.ok(shadow.includes('#FF0000'));
  assert.ok(shadow.split(',').length >= 8);

  assert.deepEqual(wrapCaptionWords(['one', 'two', 'three', 'four', 'five', 'six'], 4, 2), [
    ['one', 'two', 'three'],
    ['four', 'five', 'six'],
  ]);
  assert.deepEqual(wrapCaptionWords(['MIDDLE', 'CHECKPOINT', 'AT', '34', 'SECONDS.'], 4, 2), [
    ['MIDDLE', 'CHECKPOINT'],
    ['AT', '34', 'SECONDS.'],
  ]);

  assert.equal(mapFontFamilyToAss('JetBrains Mono'), 'JetBrains Mono');
  assert.equal(mapFontFamilyToAss('Outfit'), 'Noto Sans');
  assert.equal(mapFontFamilyToAss('Plus Jakarta Sans'), 'Liberation Sans');
  assert.equal(mapFontFamilyToAss('DM Sans'), 'DejaVu Sans');

  assert.equal(getAssAlignment('bottom', 'left'), 1);
  assert.equal(getAssAlignment('bottom', 'center'), 2);
  assert.equal(getAssAlignment('bottom', 'right'), 3);
  assert.equal(getAssAlignment('center', 'center'), 5);
  assert.equal(getAssAlignment('top', 'right'), 9);
});
