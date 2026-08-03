import { describe, expect, it } from 'vitest';

type PublishingSurfaceAccess = {
  catalog: boolean;
  official: boolean;
  officialApproved: boolean;
  officialAudit: boolean;
  officialRollback: boolean;
  officialWorkflow: boolean;
};

describe('publishing surface access', () => {
  it('matches Admin roles to the Cloud official-Agent read surfaces', async () => {
    const capabilities = await import('./capabilities');
    const getPublishingSurfaceAccess = (
      capabilities as typeof capabilities & {
        getPublishingSurfaceAccess?: (role: Api.Auth.AdminRole | '') => PublishingSurfaceAccess;
      }
    ).getPublishingSurfaceAccess;

    expect(getPublishingSurfaceAccess).toBeTypeOf('function');
    if (!getPublishingSurfaceAccess) return;

    expect({
      auditor: getPublishingSurfaceAccess('auditor'),
      finance_admin: getPublishingSurfaceAccess('finance_admin'),
      operations_admin: getPublishingSurfaceAccess('operations_admin'),
      publisher: getPublishingSurfaceAccess('publisher'),
      super_admin: getPublishingSurfaceAccess('super_admin')
    }).toEqual({
      auditor: {
        catalog: false,
        official: true,
        officialApproved: true,
        officialAudit: true,
        officialRollback: false,
        officialWorkflow: true
      },
      finance_admin: {
        catalog: false,
        official: false,
        officialApproved: false,
        officialAudit: false,
        officialRollback: false,
        officialWorkflow: false
      },
      operations_admin: {
        catalog: false,
        official: true,
        officialApproved: true,
        officialAudit: false,
        officialRollback: false,
        officialWorkflow: false
      },
      publisher: {
        catalog: true,
        official: true,
        officialApproved: true,
        officialAudit: false,
        officialRollback: false,
        officialWorkflow: true
      },
      super_admin: {
        catalog: true,
        official: true,
        officialApproved: true,
        officialAudit: true,
        officialRollback: true,
        officialWorkflow: true
      }
    });
  });

  it('fails closed before authentication', async () => {
    const capabilities = await import('./capabilities');
    const getPublishingSurfaceAccess = (
      capabilities as typeof capabilities & {
        getPublishingSurfaceAccess?: (role: Api.Auth.AdminRole | '') => PublishingSurfaceAccess;
      }
    ).getPublishingSurfaceAccess;

    expect(getPublishingSurfaceAccess).toBeTypeOf('function');
    if (!getPublishingSurfaceAccess) return;

    expect(getPublishingSurfaceAccess('')).toEqual({
      catalog: false,
      official: false,
      officialApproved: false,
      officialAudit: false,
      officialRollback: false,
      officialWorkflow: false
    });
  });
});
