import { describe, expect, it } from 'vitest';
import { isStepUpRequired, useStepUp } from './use-step-up';
import { CloudServiceError } from '@/service/cloud';

describe('useStepUp', () => {
  it('detects 428 errors from any service error carrying a status', () => {
    expect(isStepUpRequired(new CloudServiceError('step-up-required', 428, '需要二次验证'))).toBe(true);
    expect(isStepUpRequired(new CloudServiceError('forbidden', 403, '无权'))).toBe(false);
    expect(isStepUpRequired(new Error('other'))).toBe(false);
    expect(isStepUpRequired(undefined)).toBe(false);
  });

  it('retries the action after a successful verification', async () => {
    const { onStepUpVerified, runProtected, showStepUp } = useStepUp();
    let attempts = 0;
    const action = () => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new CloudServiceError('step-up-required', 428, '需要二次验证'));
      }
      return Promise.resolve('ok');
    };

    const pending = runProtected(action);
    await Promise.resolve();
    expect(showStepUp.value).toBe(true);

    onStepUpVerified();
    await expect(pending).resolves.toBe('ok');
    expect(attempts).toBe(2);
    expect(showStepUp.value).toBe(false);
  });

  it('rethrows the original error when verification is cancelled', async () => {
    const { onStepUpCancelled, runProtected } = useStepUp();
    const failure = new CloudServiceError('step-up-required', 428, '需要二次验证');
    const pending = runProtected(() => Promise.reject(failure));
    await Promise.resolve();

    onStepUpCancelled();
    await expect(pending).rejects.toBe(failure);
  });

  it('passes through non-step-up failures without opening the dialog', async () => {
    const { runProtected, showStepUp } = useStepUp();
    const failure = new CloudServiceError('forbidden', 403, '无权');
    await expect(runProtected(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(showStepUp.value).toBe(false);
  });
});
