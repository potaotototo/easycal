'use client';

import { apiBaseUrl } from './events-api.ts';
import { clearSessionToken, NotAuthenticatedError, readSessionToken } from './session.ts';

/**
 * Folder selection. A Telegram folder is a live filter, so the worker re-resolves it
 * on every run — picking one here is a standing instruction, not a snapshot of the
 * chats it contains today.
 */

export interface TelegramFolder {
  telegramFolderId: number;
  title: string;
  refreshedAt: string;
}

export interface FolderSelection {
  telegramFolderId: number;
  folderTitle: string;
  lookbackDays: number;
}

export interface FoldersResponse {
  folders: TelegramFolder[];
  selected: FolderSelection | null;
}

function url(path: string) {
  return `${apiBaseUrl ?? ''}${path}`;
}

function authHeaders(): Record<string, string> {
  const token = readSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function assertAuthenticated(response: Response) {
  if (response.status === 401) {
    clearSessionToken();
    throw new NotAuthenticatedError();
  }
}

export async function fetchFolders(): Promise<FoldersResponse> {
  const response = await fetch(url('/v1/folders'), {
    credentials: 'include',
    headers: { Accept: 'application/json', ...authHeaders() },
    cache: 'no-store',
  });

  assertAuthenticated(response);

  if (response.status === 409) {
    throw new Error('Connect your Telegram account first.');
  }
  if (!response.ok) {
    throw new Error(`Could not load folders (${response.status})`);
  }

  return (await response.json()) as FoldersResponse;
}

export async function saveFolderSelection(selection: FolderSelection): Promise<void> {
  const response = await fetch(url('/v1/folder-selection'), {
    method: 'PUT',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(selection),
  });

  assertAuthenticated(response);

  if (!response.ok) {
    throw new Error(`Could not save your folder choice (${response.status})`);
  }
}

/** Queues a sync. The API allows one per connection per minute. */
export async function triggerSync(): Promise<'queued' | 'rate_limited'> {
  const response = await fetch(url('/v1/sync-runs'), {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', ...authHeaders() },
  });

  assertAuthenticated(response);

  if (response.status === 429) return 'rate_limited';
  if (!response.ok) {
    throw new Error(`Could not start a sync (${response.status})`);
  }
  return 'queued';
}
