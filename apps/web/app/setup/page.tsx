'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  fetchFolders,
  saveFolderSelection,
  triggerSync,
  type FolderSelection,
  type TelegramFolder,
} from '../lib/folders-api.ts';
import { isDemoMode } from '../lib/events-api.ts';
import { NotAuthenticatedError } from '../lib/session.ts';

const LOOKBACK_CHOICES = [3, 7, 14, 30];

/**
 * Choose which Telegram folder EasyCal reads.
 *
 * The folder is a live filter, not a fixed list: the worker re-resolves it on every
 * run, so a channel you join later is picked up automatically without coming back
 * here. Muted channels are included — that is the point of the product.
 */
export default function SetupPage() {
  const [folders, setFolders] = useState<TelegramFolder[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [lookbackDays, setLookbackDays] = useState(7);
  const [saved, setSaved] = useState<FolderSelection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!isDemoMode);
  const [isBusy, setIsBusy] = useState(false);

  const load = useCallback(async () => {
    if (isDemoMode) return;
    setIsLoading(true);
    setError(null);
    try {
      const { folders: available, selected } = await fetchFolders();
      setFolders(available);
      setSaved(selected);
      setSelectedId(selected?.telegramFolderId ?? available[0]?.telegramFolderId ?? null);
      if (selected) setLookbackDays(selected.lookbackDays);
    } catch (caught) {
      if (caught instanceof NotAuthenticatedError) {
        window.location.assign('/login');
        return;
      }
      setError(caught instanceof Error ? caught.message : 'Could not load your folders.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  async function run(action: () => Promise<void>) {
    setIsBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      if (caught instanceof NotAuthenticatedError) {
        window.location.assign('/login');
        return;
      }
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setIsBusy(false);
    }
  }

  if (isDemoMode) {
    return (
      <main className="app-shell">
        <section className="calendar-card">
          <p className="eyebrow">Setup</p>
          <h1>EasyCal is in preview mode</h1>
          <p className="subheading">
            Set <code>NEXT_PUBLIC_API_BASE_URL</code> to your EasyCal API to choose a folder.
          </p>
        </section>
      </main>
    );
  }

  const chosen = folders.find((folder) => folder.telegramFolderId === selectedId);

  return (
    <main className="app-shell">
      <section className="calendar-card">
        <p className="eyebrow">Setup</p>
        <h1>Choose a Telegram folder</h1>
        <p className="subheading">
          EasyCal reads recent messages from the chats in one folder. It re-checks the
          folder on every sync, so channels you join later are included automatically —
          muted ones too.
        </p>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => void load()}>Try again</button>
          </div>
        )}
        {notice && <p className="detail-description" role="status">{notice}</p>}

        {isLoading ? (
          <p className="detail-description">Loading your folders…</p>
        ) : folders.length === 0 ? (
          <p className="detail-description">
            No folders found on your Telegram account. Create one in Telegram
            (Settings → Folders), then sign in again so EasyCal can see it.
          </p>
        ) : (
          <form
            className="correction-fields"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                if (selectedId === null || !chosen) throw new Error('Pick a folder first.');
                await saveFolderSelection({
                  telegramFolderId: selectedId,
                  folderTitle: chosen.title,
                  lookbackDays,
                });
                setSaved({
                  telegramFolderId: selectedId,
                  folderTitle: chosen.title,
                  lookbackDays,
                });
                setNotice(`Saved. EasyCal will read "${chosen.title}".`);
              });
            }}
          >
            <fieldset className="field field-wide" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend><span>Folder</span></legend>
              {folders.map((folder) => (
                <label
                  key={folder.telegramFolderId}
                  style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}
                >
                  <input
                    type="radio"
                    name="folder"
                    value={folder.telegramFolderId}
                    checked={selectedId === folder.telegramFolderId}
                    onChange={() => setSelectedId(folder.telegramFolderId)}
                  />
                  <span>{folder.title}</span>
                </label>
              ))}
            </fieldset>

            <label className="field field-wide">
              <span>How far back to read</span>
              <select
                value={lookbackDays}
                onChange={(event) => setLookbackDays(Number(event.target.value))}
              >
                {LOOKBACK_CHOICES.map((days) => (
                  <option key={days} value={days}>{days} days</option>
                ))}
              </select>
            </label>

            <div className="dialog-actions">
              <button type="submit" className="accept-button" disabled={isBusy || selectedId === null}>
                {isBusy ? 'Saving…' : saved ? 'Update folder' : 'Save folder'}
              </button>
            </div>
          </form>
        )}

        {saved && (
          <div className="correction-fields">
            <p className="detail-description">
              Reading <strong>{saved.folderTitle}</strong>, last {saved.lookbackDays} days.
              Syncs run automatically every 15 minutes.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="correct-button"
                disabled={isBusy}
                onClick={() =>
                  void run(async () => {
                    const result = await triggerSync();
                    setNotice(
                      result === 'queued'
                        ? 'Sync queued. Give it a moment, then open the calendar.'
                        : 'A sync ran very recently — try again in a minute.',
                    );
                  })
                }
              >
                {isBusy ? 'Working…' : 'Sync now'}
              </button>
              <Link className="accept-button" href="/">Open calendar</Link>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
