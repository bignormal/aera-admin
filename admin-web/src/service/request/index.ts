import type { AxiosResponse } from 'axios';
import { BACKEND_ERROR_CODE, createFlatRequest } from '@sa/axios';
import { getServiceBaseURL } from '@/utils/service';
import { showErrorMsg } from './shared';
import type { RequestInstanceState } from './type';

const { baseURL } = getServiceBaseURL(import.meta.env, false);

/**
 * Retained only for Soybean's optional dynamic-route API.
 * Aera business modules use the native fetch wrapper in `service/http.ts`.
 */
export const request = createFlatRequest(
  {
    baseURL,
    withCredentials: true
  },
  {
    defaultState: {
      errMsgStack: []
    } as RequestInstanceState,
    transform(response: AxiosResponse<App.Service.Response<unknown>>) {
      return response.data.data;
    },
    isBackendSuccess(response) {
      return String(response.data.code) === import.meta.env.VITE_SERVICE_SUCCESS_CODE;
    },
    async onBackendFail() {
      return null;
    },
    onError(error) {
      let message = error.message;

      if (error.code === BACKEND_ERROR_CODE) {
        message = error.response?.data?.msg || message;
      }

      showErrorMsg(request.state, message);
    }
  }
);
