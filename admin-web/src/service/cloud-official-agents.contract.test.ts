import { expect, expectTypeOf, it } from 'vitest';
import type { OfficialDraft, OfficialRelease, OfficialSubmission, OfficialVersion } from './cloud-official-agents';
import { releaseActionsFor, reviewOfficialSubmission } from './cloud-official-agents';

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

it('projects release actions by local role and release state', () => {
  expect(releaseActionsFor({ role: 'publisher', status: 'approved' })).toEqual([]);
  expect(releaseActionsFor({ role: 'operations_admin', status: 'approved' })).toEqual(['activate']);
  expect(releaseActionsFor({ role: 'operations_admin', status: 'active' })).toEqual(['rollout', 'pause']);
  expect(releaseActionsFor({ role: 'operations_admin', status: 'paused' })).toEqual(['rollout', 'resume']);
});
