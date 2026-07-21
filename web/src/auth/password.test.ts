import { describe, expect, it } from 'vitest';

import { administratorPasswordSchema } from './password';

describe('administratorPasswordSchema', () => {
  it('counts Unicode scalar values like the Go password policy', () => {
    expect(administratorPasswordSchema.safeParse('🔐'.repeat(11)).success).toBe(false);
    expect(administratorPasswordSchema.safeParse('🔐'.repeat(12)).success).toBe(true);
    expect(administratorPasswordSchema.safeParse('密碼安全測試至少十二個字元').success).toBe(true);
  });

  it('rejects invalid Unicode and values longer than 128 characters', () => {
    expect(administratorPasswordSchema.safeParse('\ud800'.repeat(12)).success).toBe(false);
    expect(administratorPasswordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });
});
