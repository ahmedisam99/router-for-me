import { canSetPriority, type RoutingCredential } from '@/services/api/routing';

export const moveItem = <T>(list: readonly T[], from: number, to: number): T[] => {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

/**
 * Distinct priorities that pin the given order, highest first, for the credentials that can
 * hold one. Only changed values are returned.
 */
export const priorityChanges = (ordered: readonly RoutingCredential[]) => {
  const settable = ordered.filter(canSetPriority);
  return settable.flatMap((credential, index) => {
    const priority = settable.length - index;
    return credential.priority === priority ? [] : [{ credential, priority }];
  });
};

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

/** pickRanks over the rows still in line; a disabled row is out of line and gets null. */
export const lineRanks = (
  rows: readonly {
    disabled: boolean;
    credential: Pick<RoutingCredential, 'priority' | 'provider'>;
  }[],
  strategy: string | undefined
): (number | null)[] => {
  const live = rows.filter((row) => !row.disabled);
  const ranks = pickRanks(
    live.map((row) => row.credential),
    strategy
  );
  const byRow = new Map(live.map((row, index) => [row, ranks[index]]));
  return rows.map((row) => byRow.get(row) ?? null);
};
