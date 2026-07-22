/** Host-authenticated identity. This is the exact Taproot 0.3 authorization shape. */
export interface AuthorizationContext {
  installationId: string;
  principalId: string;
  activeWorkspaceId: string | null;
  workspaceIds: readonly string[];
  capabilities: readonly string[];
  authorizationRevision: number;
}

export type VisibilityAtomV1 =
  | { kind: 'public' }
  | { kind: 'principal'; principalId: string }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'capability'; capability: string };

export interface VisibilityScopeV1 {
  version: 1;
  /** AND of clauses; atoms within a clause are ORed. Empty is public. */
  clauses: readonly (readonly VisibilityAtomV1[])[];
}
