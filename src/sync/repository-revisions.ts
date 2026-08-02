export interface RepositoryRefreshToken {
  key: string;
  requestId: number;
  revision: number;
}

interface RepositoryRevisionState {
  revision: number;
  latestRequestId: number;
  issueMutations: Map<string, number>;
}

const states = new Map<string, RepositoryRevisionState>();

const repositoryKey = (accountId: string, repositoryFullName: string) =>
  `${accountId}\u0000${repositoryFullName}`;

const stateFor = (accountId: string, repositoryFullName: string): RepositoryRevisionState => {
  const key = repositoryKey(accountId, repositoryFullName);
  const existing = states.get(key);
  if (existing) return existing;
  const created = { revision: 0, latestRequestId: 0, issueMutations: new Map<string, number>() };
  states.set(key, created);
  return created;
};

export function beginRepositoryRefresh(
  accountId: string,
  repositoryFullName: string,
): RepositoryRefreshToken {
  const state = stateFor(accountId, repositoryFullName);
  state.latestRequestId += 1;
  return {
    key: repositoryKey(accountId, repositoryFullName),
    requestId: state.latestRequestId,
    revision: state.revision,
  };
}

export function markRepositoryMutation(
  accountId: string,
  repositoryFullName: string,
  entityKey: string,
): number {
  const state = stateFor(accountId, repositoryFullName);
  state.revision += 1;
  state.issueMutations.set(entityKey, state.revision);
  return state.revision;
}

export function wasMutatedAfter(token: RepositoryRefreshToken, entityKey: string): boolean {
  const state = states.get(token.key);
  return (state?.issueMutations.get(entityKey) ?? 0) > token.revision;
}

export function isLatestRepositoryRefresh(token: RepositoryRefreshToken): boolean {
  return states.get(token.key)?.latestRequestId === token.requestId;
}

export function resetRepositoryRevisions(): void {
  states.clear();
}
