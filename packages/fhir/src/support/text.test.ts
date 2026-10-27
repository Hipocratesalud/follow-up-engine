import { describe, expect, it } from 'vitest';
import { decodeBase64Utf8, encodeBase64Utf8, xhtmlToText } from './text.ts';

describe('xhtmlToText', () => {
  it('keeps block structure as line breaks and decodes entities', () => {
    const div =
      '<div xmlns="http://www.w3.org/1999/xhtml"><p><b>Plan:</b> HbA1c&nbsp;en 3 meses</p>' +
      '<ul><li>Control &amp; ajuste</li><li>Dieta &lt;1800 kcal&gt;</li></ul>a<br/>b &#233; &#xE9;</div>';
    expect(xhtmlToText(div)).toBe(
      'Plan: HbA1c en 3 meses\n- Control & ajuste\n- Dieta <1800 kcal>\n\na\nb é é',
    );
  });

  it('drops scripts and styles entirely', () => {
    expect(xhtmlToText('<div><style>p{}</style><script>alert(1)</script>ok</div>')).toBe('ok');
  });

  it('drops control characters and references to no character', () => {
    expect(xhtmlToText('<p>a&#0;b &#99999999; &#x1F600;</p>')).toBe('ab &#99999999; 😀');
  });

  it('leaves unknown entities untouched', () => {
    expect(xhtmlToText('<p>&bogus; &amp;</p>')).toBe('&bogus; &');
  });
});

describe('base64', () => {
  it('round-trips UTF-8 text', () => {
    const text = 'Ácido tranexámico 500 mg c/8h — ñandú';
    expect(decodeBase64Utf8(encodeBase64Utf8(text))).toBe(text);
  });

  it('drops a NUL from the decoded text', () => {
    expect(decodeBase64Utf8(encodeBase64Utf8('DM2.\u0000\nPlan'))).toBe('DM2.\nPlan');
  });

  it('tolerates whitespace in the encoded data', () => {
    expect(decodeBase64Utf8('SG9s\nYQ==')).toBe('Hola');
  });

  it.each(['%%%', 'abcde', '//79'])('rejects invalid base64 or non-UTF-8 bytes (%j)', (data) => {
    expect(decodeBase64Utf8(data)).toBeUndefined();
  });
});
