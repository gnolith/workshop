export {
  CATALOG_DIGEST,
  OPERATION_ROUTE_PREFIX,
  OPERATION_SCHEMA_VERSION,
  legacyOperationNames,
  operationCatalog,
  type OperationInput,
  type OperationName,
  type OperationOutput,
} from '../generated/operations.js';

export const WORKSHOP_SEARCH_KINDS = [
  'statement',
  'item',
  'task',
  'memory',
  'prompt',
  'resource',
  'annotation',
] as const;

export type WorkshopSearchKind = (typeof WORKSHOP_SEARCH_KINDS)[number];
export type WorkshopEntityType = 'item' | 'property';

export interface WorkshopSearchResultIdentity {
  kind: WorkshopSearchKind;
  id: string;
  revision: number;
  entityType?: WorkshopEntityType;
}

export function assertSearchResultIdentity(
  value: WorkshopSearchResultIdentity,
): void {
  if (value.kind === 'item') {
    if (value.entityType !== 'item' && value.entityType !== 'property')
      throw new TypeError('item search results require entityType');
  } else if (value.entityType !== undefined) {
    throw new TypeError('entityType is only valid for item search results');
  }
}
