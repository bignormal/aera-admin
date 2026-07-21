import { z } from 'zod';

function unicodeScalarLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return -1;
    length += 1;
  }
  return length;
}

export const administratorPasswordSchema = z.string().superRefine((value, context) => {
  const length = unicodeScalarLength(value);
  if (length < 12) {
    context.addIssue({ code: 'custom', message: '密码至少需要 12 个字符' });
  } else if (length > 128) {
    context.addIssue({ code: 'custom', message: '密码最多 128 个字符' });
  }
});
