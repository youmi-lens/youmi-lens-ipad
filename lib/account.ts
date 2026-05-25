import { API_BASE_URL } from './config';

type DeleteAccountResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
};

export async function deleteAccount(accessToken: string | null | undefined): Promise<void> {
  if (!API_BASE_URL) throw new Error('Missing API base URL.');
  if (!accessToken) throw new Error('Please sign in to delete your account.');

  const response = await fetch(`${API_BASE_URL}/api/account`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const payload = (await response.json().catch(() => null)) as DeleteAccountResponse | null;

  if (!response.ok || !payload?.ok) {
    throw new Error(
      payload?.message ?? payload?.error ?? `Account deletion failed with HTTP ${response.status}.`,
    );
  }
}
