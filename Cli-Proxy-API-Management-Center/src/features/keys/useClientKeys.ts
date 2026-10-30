import { useCallback, useEffect, useRef, useState } from 'react';
import { clientKeysApi, type ClientKeysData, type PriceTable } from '@/services/api/clientKeys';
import { useAuthStore } from '@/stores';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Client keys with their profiles, and the price table; each fails on its own. */
export function useClientKeys() {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const [data, setData] = useState<ClientKeysData | null>(null);
  const [prices, setPrices] = useState<PriceTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pricesError, setPricesError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    if (connectionStatus !== 'connected') return;
    const [keys, table] = await Promise.allSettled([
      clientKeysApi.list(),
      clientKeysApi.getPrices(),
    ]);
    if (request !== requestRef.current) return;
    if (keys.status === 'fulfilled') {
      setData(keys.value);
      setError(null);
    } else {
      setError(errorText(keys.reason));
    }
    if (table.status === 'fulfilled') {
      setPrices(table.value);
      setPricesError(null);
    } else {
      setPricesError(errorText(table.reason));
    }
  }, [connectionStatus]);

  useEffect(() => {
    setData(null);
    setPrices(null);
    setError(null);
    setPricesError(null);
    void load();
  }, [apiBase, load]);

  return { data, prices, error, pricesError, reload: load };
}
