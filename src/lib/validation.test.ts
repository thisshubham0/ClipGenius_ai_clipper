import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes,
  formatGoogleAuthError,
  isFirebasePopupPendingPromiseError,
  validateAuthForm,
  validateImportUrl,
  validateVideoFile,
} from './validation';

test('validateVideoFile accepts supported extensions and valid MIME types', () => {
  const res = validateVideoFile({
    name: 'founder-podcast-ep14.mp4',
    size: 42 * 1024 * 1024,
    type: 'video/mp4',
  });
  assert.equal(res.valid, true);
  assert.equal(res.extension, '.mp4');
});

test('validateVideoFile rejects unsupported extensions', () => {
  const res = validateVideoFile({
    name: 'transcript.pdf',
    size: 1024,
    type: 'application/pdf',
  });
  assert.equal(res.valid, false);
  assert.match(res.error ?? '', /Unsupported file format/);
});

test('validateVideoFile rejects files exceeding plan size limit', () => {
  const res = validateVideoFile(
    {
      name: 'keynote.mov',
      size: 600 * 1024 * 1024,
      type: 'video/quicktime',
    },
    500 * 1024 * 1024
  );
  assert.equal(res.valid, false);
  assert.match(res.error ?? '', /exceeds/);
});

test('validateImportUrl accepts YouTube, Vimeo, and direct video links', () => {
  assert.equal(validateImportUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').valid, true);
  assert.equal(validateImportUrl('https://youtu.be/dQw4w9WgXcQ').valid, true);
  assert.equal(validateImportUrl('https://vimeo.com/123456789').valid, true);
  assert.equal(validateImportUrl('https://cdn.example.com/studio-cut.mp4').valid, true);
});

test('validateImportUrl rejects non-video domains and malformed URLs', () => {
  assert.equal(validateImportUrl('not-a-url').valid, false);
  assert.equal(validateImportUrl('https://example.com/article').valid, false);
});

test('validateAuthForm enforces email, name on signup, and 8+ char password', () => {
  assert.equal(validateAuthForm('signin', { email: 'bad', password: 'password123' }).valid, false);
  assert.equal(validateAuthForm('signin', { email: 'creator@studio.io', password: 'short' }).valid, false);
  assert.equal(
    validateAuthForm('signup', { email: 'creator@studio.io', password: 'password123', name: 'A' }).valid,
    false
  );
  assert.equal(
    validateAuthForm('signup', {
      email: 'creator@studio.io',
      password: 'password123',
      name: 'Maya Chen',
    }).valid,
    true
  );
  assert.equal(validateAuthForm('reset', { email: 'creator@studio.io' }).valid, true);
});

test('formatBytes formats sizes cleanly', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024 * 1024 * 45), '45 MB');
});

test('isFirebasePopupPendingPromiseError and formatGoogleAuthError handle Firebase Auth popup race cleanly', () => {
  const assertionErr = new Error('INTERNAL ASSERTION FAILED: Pending promise was never set');
  assert.equal(isFirebasePopupPendingPromiseError(assertionErr), true);
  assert.equal(isFirebasePopupPendingPromiseError(new Error('network error')), false);

  const formattedAssertion = formatGoogleAuthError(assertionErr);
  assert.equal(formattedAssertion.kind, 'info');
  assert.doesNotMatch(formattedAssertion.message, /INTERNAL ASSERTION FAILED/);

  const formattedClosed = formatGoogleAuthError({ code: 'auth/popup-closed-by-user' });
  assert.equal(formattedClosed.kind, 'info');

  const formattedBlocked = formatGoogleAuthError({ code: 'auth/popup-blocked' });
  assert.equal(formattedBlocked.kind, 'error');
});
