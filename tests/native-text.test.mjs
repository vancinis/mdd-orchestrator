import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authoredNativeText, canonicalNativeText, firstDivergence } from '../dist/native-text.js';

const SID = 'ses_1';
const MID = 'msg_1';
function part(text, extra = {}) { return { type: 'text', sessionID: SID, messageID: MID, text, ...extra }; }

test('authoredNativeText joins only authored parts, excluding host-synthetic and ignored ones', () => {
  const parts = [part('Please implement '), { type: 'text', sessionID: SID, messageID: MID, text: '@file', synthetic: true }, part('the change.')];
  assert.equal(authoredNativeText(parts, SID, MID), 'Please implement \nthe change.');
});

test('authoredNativeText excludes an ignored part the same way as a synthetic one', () => {
  const parts = [part('Real text.'), { type: 'text', sessionID: SID, messageID: MID, text: 'noise', ignored: true }];
  assert.equal(authoredNativeText(parts, SID, MID), 'Real text.');
});

test('a message with no authored text left is not a candidate at all', () => {
  const parts = [{ type: 'text', sessionID: SID, messageID: MID, text: '@mention', synthetic: true }];
  assert.equal(authoredNativeText(parts, SID, MID), undefined);
});

test('authoredNativeText still enforces per-part ownership on the parts it keeps', () => {
  const parts = [part('Owned.'), part('Not owned.', { sessionID: 'ses_other' })];
  assert.throws(() => authoredNativeText(parts, SID, MID), /ownership/);
});

test('authoredNativeText rejects a non-string text field even when the part is otherwise owned', () => {
  const parts = [part('Owned.'), part(42)];
  assert.throws(() => authoredNativeText(parts, SID, MID), /ownership/);
});

test('canonicalNativeText folds CRLF and CR to LF and trims outer edges, nothing else', () => {
  assert.equal(canonicalNativeText('  Line one\r\nLine two\rLine three  \n'), 'Line one\nLine two\nLine three');
  // Case, inner whitespace and compatibility forms are left untouched: folding them would turn an
  // exact-match comparison into an approximate one.
  assert.equal(canonicalNativeText('Keep  Case AND   Spacing'), 'Keep  Case AND   Spacing');
});

test('firstDivergence reports the first differing offset, or the shorter length when one is a prefix of the other', () => {
  assert.equal(firstDivergence('hello world', 'hello there'), 6);
  assert.equal(firstDivergence('same', 'same'), 4);
  assert.equal(firstDivergence('short', 'shorter'), 5);
});
