import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Soybean public environment defaults', () => {
  it('ships the Vite configuration required by a clean checkout', () => {
    const envPath = resolve(process.cwd(), '.env');
    const exists = existsSync(envPath);

    expect(exists, 'admin-web/.env must be tracked because it contains only public VITE_* defaults').toBe(true);
    if (!exists) return;

    const env = readFileSync(envPath, 'utf8');
    expect(env).toContain('VITE_BASE_URL=/admin/');
    expect(env).toContain('VITE_ICON_PREFIX=icon');
    expect(env).toContain('VITE_ICON_LOCAL_PREFIX=icon-local');
  });
});
