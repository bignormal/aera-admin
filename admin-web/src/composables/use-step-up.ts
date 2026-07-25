import { ref } from 'vue';

// 高危操作 StepUp 守卫：捕获 428 STEP_UP_REQUIRED/TOTP_NOT_ENROLLED，
// 弹出 TOTP 验证对话框，验证通过后自动重试原请求。
type StatusCarrier = { status?: unknown };

export function isStepUpRequired(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as StatusCarrier).status === 428;
}

export function useStepUp() {
  const showStepUp = ref(false);
  let resolver: ((verified: boolean) => void) | undefined;

  function requestVerification(): Promise<boolean> {
    showStepUp.value = true;
    return new Promise(resolve => {
      resolver = resolve;
    });
  }

  function onStepUpVerified() {
    showStepUp.value = false;
    resolver?.(true);
    resolver = undefined;
  }

  function onStepUpCancelled() {
    showStepUp.value = false;
    resolver?.(false);
    resolver = undefined;
  }

  async function runProtected<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (!isStepUpRequired(error)) throw error;
      const verified = await requestVerification();
      if (!verified) throw error;
      return await action();
    }
  }

  return { onStepUpCancelled, onStepUpVerified, runProtected, showStepUp };
}
