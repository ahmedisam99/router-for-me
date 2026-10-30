import type { RoutingCredential } from '@/services/api/credentialRouting';

/**
 * 1-based pick rank per credential, given in pick order. Fill-first walks them one by one, except
 * that an equal-priority tier spanning several providers shares a rank: the proxy breaks that tie
 * by provider on one path and by ID on another. Other strategies rotate within a tier.
 */
export const pickRanks = (
  ordered: readonly Pick<RoutingCredential, 'priority' | 'provider'>[],
  strategy: string | undefined
) => {
  const ranks: number[] = [];
  let rank = 0;
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].priority === ordered[start].priority) end += 1;
    const tier = ordered.slice(start, end);
    const shared =
      strategy !== 'fill-first' || new Set(tier.map((credential) => credential.provider)).size > 1;
    tier.forEach(() => {
      if (!shared || ranks.length === start) rank += 1;
      ranks.push(rank);
    });
    start = end;
  }
  return ranks;
};
