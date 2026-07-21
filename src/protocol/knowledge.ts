export type EntityId = `Q${number}` | `P${number}`;

export interface KnowledgeWriteResult {
  entityId: EntityId;
  previousRevision: number | null;
  newRevision: number;
  entity: unknown;
  changedStatementIds?: string[];
}

export interface KnowledgeToolCall {
  name: string;
  input: Readonly<Record<string, unknown>>;
}

export interface KnowledgeService {
  call(
    call: KnowledgeToolCall,
    context: { principalId: string; requestId?: string },
  ): Promise<unknown>;
  health?(): Promise<boolean>;
}
