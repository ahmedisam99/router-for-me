import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AUTH_FILES_CHANGED_EVENT } from '@/features/authFiles/authFilesEvents';
import { useProviderWorkbench } from '@/features/providers/useProviderWorkbench';
import { authFilesApi } from '@/services/api/authFiles';
import { credentialRoutingApi, type RoutingCredential } from '@/services/api/credentialRouting';
import { useAuthStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { buildCredentialRows } from './rows';

/** Every credential in pick order, joined with its config resource or auth file. */
export function useCredentialRows() {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const workbench = useProviderWorkbench();
  const [credentials, setCredentials] = useState<RoutingCredential[] | null>(null);
  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    if (connectionStatus !== 'connected') return;
    try {
      const [nextCredentials, fileList] = await Promise.all([
        credentialRoutingApi.listCredentials(),
        authFilesApi.list(),
      ]);
      if (request !== requestRef.current) return;
      setCredentials(nextCredentials);
      setFiles(fileList.files ?? []);
      setError(null);
    } catch (err) {
      if (request !== requestRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [connectionStatus]);

  useEffect(() => {
    setCredentials(null);
    setFiles([]);
    void load();
  }, [apiBase, load]);

  // Logins, uploads and deletes anywhere announce themselves through this event.
  useEffect(() => {
    const onChange = () => void load();
    window.addEventListener(AUTH_FILES_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(AUTH_FILES_CHANGED_EVENT, onChange);
  }, [load]);

  const { refetch } = workbench;
  const refresh = useCallback(async () => {
    await Promise.allSettled([load(), refetch()]);
  }, [load, refetch]);

  const resources = useMemo(
    () => (workbench.snapshot?.groups ?? []).flatMap((group) => group.resources),
    [workbench.snapshot]
  );
  const rows = useMemo(
    () => (credentials ? buildCredentialRows(credentials, resources, files) : null),
    [credentials, files, resources]
  );

  return { rows, error, reload: load, refresh };
}
