/**
 * Account deletion ordering / consistency helpers (pure, injectable deps).
 *
 * Order:
 * 1) Preflight (Apple IAP ledger prep) — fail closed, nothing deleted
 * 2) auth.admin.deleteUser — irreversible Auth removal
 * 3) Best-effort DB + storage cleanup (service role) — failures logged, do not
 *    resurrect Auth orphans; Auth is already gone so re-registration can proceed
 */

const AUTH_NOT_FOUND = /not found|does not exist/i;

export type AccountDeletionDeps = {
  userId: string;
  prepareApple: (userId: string) => Promise<unknown>;
  deleteAuthUser: (userId: string) => Promise<{ error?: { message?: string } | null }>;
  removeStorage: (userId: string) => Promise<unknown>;
  deleteBusinessRows: (userId: string) => Promise<unknown[]>;
};

export type AccountDeletionResult = {
  ok: true;
  authDeleted: true;
  storage: unknown;
  deleted: unknown[];
  cleanupErrors: Array<{ step: string; message: string }>;
};

export async function runAccountDeletion(deps: AccountDeletionDeps): Promise<AccountDeletionResult> {
  const { userId, prepareApple, deleteAuthUser, removeStorage, deleteBusinessRows } = deps;

  await prepareApple(userId);

  const { error: authError } = await deleteAuthUser(userId);
  if (authError && !AUTH_NOT_FOUND.test(authError.message ?? '')) {
    const err = new Error(authError.message ?? 'auth_delete_failed') as Error & { name: string };
    err.name = 'AuthDeleteFailedError';
    throw err;
  }

  const cleanupErrors: Array<{ step: string; message: string }> = [];
  let storage: unknown = null;
  let deleted: unknown[] = [];

  try {
    storage = await removeStorage(userId);
  } catch (error) {
    cleanupErrors.push({
      step: 'storage',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    deleted = await deleteBusinessRows(userId);
  } catch (error) {
    cleanupErrors.push({
      step: 'business_rows',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    ok: true,
    authDeleted: true,
    storage,
    deleted,
    cleanupErrors,
  };
}
