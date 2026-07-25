declare namespace Api {
  namespace Auth {
    type AdminRole = 'auditor' | 'finance_admin' | 'operations_admin' | 'publisher' | 'super_admin';

    interface UserInfo {
      userId: string;
      userName: string;
      email: string;
      role: AdminRole | '';
      roles: AdminRole[];
      buttons: string[];
    }
  }
}
