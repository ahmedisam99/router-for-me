import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AUTH_FILES_CHANGED_EVENT } from '@/features/authFiles/authFilesEvents';
import {
  buildProviderGroups,
  useProviderWorkbench,
} from '@/features/providers/useProviderWorkbench';
import { authFilesApi } from '@/services/api/authFiles';
import { routingApi, type RoutingCredential } from '@/services/api/routing';
import { useAuthStore } from '@/stores';
import type { AuthFileItem, Config } from '@/types';
import { buildCredentialRows } from './rows';

/** How many rows the Credentials page lists, for the sidebar badge. */
export const credentialCount = (credentials: readonly RoutingCredential[], config: Config | null) =>
  buildCredentialRows(
    credentials,
    config ? buildProviderGroups(config).flatMap((group) => group.resources) : [],
    []
  ).length;

/** Every credential in pick order, joined with the editors that own it. */
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
        routingApi.listCredentials(),
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

  return { rows, workbench, error, reload: load, refresh };
}
