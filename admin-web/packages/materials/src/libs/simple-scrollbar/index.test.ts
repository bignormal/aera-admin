import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const componentSource = readFileSync(
  resolve(process.cwd(), 'packages/materials/src/libs/simple-scrollbar/index.vue'),
  'utf8'
);

describe('SimpleScrollbar', () => {
  it('hides the visual scrollbar track without replacing the scroll container', () => {
    expect(componentSource).toContain('<Simplebar class="h-full">');
    expect(componentSource).toMatch(/:deep\(\.simplebar-track\)\s*\{[^}]*display:\s*none;/s);
  });
});
