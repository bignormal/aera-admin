export interface RequestInstanceState {
  /** Error messages currently visible to the administrator. */
  errMsgStack: string[];
  [key: string]: unknown;
}
