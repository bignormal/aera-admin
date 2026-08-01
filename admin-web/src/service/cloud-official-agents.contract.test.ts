import { expectTypeOf, it } from 'vitest';
import type { OfficialDraft, OfficialRelease, OfficialSubmission, OfficialVersion } from './cloud-official-agents';
import { reviewOfficialSubmission } from './cloud-official-agents';

it('uses the canonical generated official Agent wire vocabulary', () => {
  expectTypeOf<OfficialDraft['kind']>().toEqualTypeOf<'initial' | 'next'>();
  expectTypeOf<OfficialSubmission['status']>().toEqualTypeOf<
    'approved' | 'pending' | 'rejected' | 'superseded' | 'withdrawn'
  >();
  expectTypeOf<OfficialRelease['channel']>().toEqualTypeOf<'internal' | 'stable'>();
  expectTypeOf<OfficialVersion['runtime_minimum_version']>().toEqualTypeOf<string>();

  type ReviewInput = Parameters<typeof reviewOfficialSubmission>[1];
  expectTypeOf<ReviewInput['payload']['decision']>().toEqualTypeOf<'approve' | 'reject'>();
  expectTypeOf<ReviewInput['payload']['initial_channels']>().toEqualTypeOf<
    readonly ('internal' | 'stable')[] | undefined
  >();
});
