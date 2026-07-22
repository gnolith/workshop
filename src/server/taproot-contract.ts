import type { VisibilityScopeV1 } from '../protocol/authorization.js';

export type TaprootEntityId = `Q${number}` | `P${number}`;
export type TaprootPropertyId = `P${number}`;
export type TaprootReferencedEntityId =
  | TaprootEntityId
  | `L${number}`
  | `L${number}-F${number}`
  | `L${number}-S${number}`
  | `E${number}`;
export type TaprootEntityDatatype =
  | 'wikibase-item'
  | 'wikibase-property'
  | 'wikibase-lexeme'
  | 'wikibase-form'
  | 'wikibase-sense'
  | 'entity-schema'
  | 'string'
  | 'external-id'
  | 'url'
  | 'commonsMedia'
  | 'monolingualtext'
  | 'time'
  | 'quantity'
  | 'globe-coordinate'
  | 'math'
  | 'musical-notation'
  | 'geo-shape'
  | 'tabular-data';

export interface TaprootLanguageValue {
  language: string;
  value: string;
}

export type TaprootLanguageMap = Record<string, TaprootLanguageValue>;
export type TaprootAliasMap = Record<string, TaprootLanguageValue[]>;

export interface TaprootEntityIdValue {
  'entity-type':
    'item' | 'property' | 'lexeme' | 'form' | 'sense' | 'entity-schema';
  'numeric-id'?: number;
  id: TaprootReferencedEntityId;
}

export interface TaprootMonolingualTextValue {
  language: string;
  text: string;
}

export interface TaprootTimeValue {
  time: string;
  timezone: number;
  before: number;
  after: number;
  precision: number;
  calendarmodel: string;
}

export interface TaprootQuantityValue {
  amount: string;
  unit: string;
  lowerBound?: string;
  upperBound?: string;
}

export interface TaprootGlobeCoordinateValue {
  latitude: number;
  longitude: number;
  altitude: number | null;
  precision: number | null;
  globe: string;
}

export type TaprootDataValueValue =
  | string
  | TaprootEntityIdValue
  | TaprootMonolingualTextValue
  | TaprootTimeValue
  | TaprootQuantityValue
  | TaprootGlobeCoordinateValue;

export interface TaprootDataValue {
  value: TaprootDataValueValue;
  type: string;
}

export interface TaprootSnak {
  snaktype: 'value' | 'somevalue' | 'novalue';
  property: TaprootPropertyId;
  hash?: string;
  datatype: TaprootEntityDatatype;
  datavalue?: TaprootDataValue;
}

export interface TaprootReference {
  hash: string;
  snaks: Record<TaprootPropertyId, TaprootSnak[]>;
  'snaks-order': TaprootPropertyId[];
}

export interface TaprootSitelink {
  site: string;
  title: string;
  badges: Array<`Q${number}`>;
  url?: string;
}

export interface TaprootAttribution {
  id: string;
  kind: 'human' | 'agent' | 'import' | 'system';
  name?: string;
  organization?: string;
  tool?: string;
  url?: string;
}

export interface TaprootEditMetadata {
  actor?: string;
  attribution?: TaprootAttribution;
  editSummary?: string;
  tags?: string[];
  requestId?: string;
}

export interface TaprootCanonicalAuthorizationPolicyInput {
  installationId: string;
  workspaceId: string | null;
  ownerPrincipalId: string;
  visibility: VisibilityScopeV1;
  statementRestrictions: Readonly<Record<string, readonly VisibilityScopeV1[]>>;
  expectedAuthorizationRevision: number;
}

export interface TaprootExpectedRevision extends TaprootEditMetadata {
  expectedRevision: number;
  authorization: TaprootCanonicalAuthorizationPolicyInput;
}

export interface TaprootStatement {
  id: string;
  type: 'statement';
  /** Authored natural-language description of this exact statement revision. */
  text: string;
  rank: 'preferred' | 'normal' | 'deprecated';
  mainsnak: TaprootSnak;
  qualifiers: Record<TaprootPropertyId, TaprootSnak[]>;
  'qualifiers-order': TaprootPropertyId[];
  references: TaprootReference[];
}

export interface TaprootCreateItemInput extends TaprootEditMetadata {
  authorization: TaprootCanonicalAuthorizationPolicyInput;
  id?: `Q${number}`;
  labels?: TaprootLanguageMap;
  descriptions?: TaprootLanguageMap;
  aliases?: TaprootAliasMap;
  claims?: Record<TaprootPropertyId, TaprootStatement[]>;
  sitelinks?: Record<string, TaprootSitelink>;
}

export interface TaprootCreatePropertyInput extends TaprootEditMetadata {
  authorization: TaprootCanonicalAuthorizationPolicyInput;
  id?: `P${number}`;
  datatype: TaprootEntityDatatype;
  labels?: TaprootLanguageMap;
  descriptions?: TaprootLanguageMap;
  aliases?: TaprootAliasMap;
  claims?: Record<TaprootPropertyId, TaprootStatement[]>;
}

export interface TaprootMutationReceipt {
  entityId: TaprootEntityId;
  previousRevision: number | null;
  newRevision: number;
  status: 'committed';
  authorizationRevision: number;
  searchGeneration: number;
}

export type TaprootAsyncMethod<
  Args extends unknown[],
  Result = TaprootMutationReceipt,
> = (...args: Args) => Promise<Result>;

/**
 * The exact Taproot surface Workshop consumes. Function properties are
 * intentional: strictFunctionTypes makes the packed-peer conformance test catch
 * argument additions, removals, and reordering.
 */
export interface TaprootKnowledgeWriter {
  createItem: TaprootAsyncMethod<[input: TaprootCreateItemInput]>;
  createProperty: TaprootAsyncMethod<[input: TaprootCreatePropertyInput]>;
  setLabel: TaprootAsyncMethod<
    [
      id: TaprootEntityId,
      language: string,
      value: string,
      edit: TaprootExpectedRevision,
    ]
  >;
  setDescription: TaprootAsyncMethod<
    [
      id: TaprootEntityId,
      language: string,
      value: string,
      edit: TaprootExpectedRevision,
    ]
  >;
  addAlias: TaprootAsyncMethod<
    [
      id: TaprootEntityId,
      language: string,
      value: string,
      edit: TaprootExpectedRevision,
    ]
  >;
  removeAlias: TaprootAsyncMethod<
    [
      id: TaprootEntityId,
      language: string,
      ordinal: number,
      edit: TaprootExpectedRevision,
    ]
  >;
  setSitelink: TaprootAsyncMethod<
    [
      id: `Q${number}`,
      site: string,
      value: TaprootSitelink,
      edit: TaprootExpectedRevision,
    ]
  >;
  removeSitelink: TaprootAsyncMethod<
    [id: `Q${number}`, site: string, edit: TaprootExpectedRevision]
  >;
  addStatement: TaprootAsyncMethod<
    [
      id: TaprootEntityId,
      statement: TaprootStatement,
      edit: TaprootExpectedRevision,
    ]
  >;
  replaceStatement: TaprootAsyncMethod<
    [
      id: TaprootEntityId,
      statementId: string,
      statement: TaprootStatement,
      edit: TaprootExpectedRevision,
    ]
  >;
  removeStatement: TaprootAsyncMethod<
    [id: TaprootEntityId, statementId: string, edit: TaprootExpectedRevision]
  >;
  setStatementRank: TaprootAsyncMethod<
    [
      id: TaprootEntityId,
      statementId: string,
      rank: TaprootStatement['rank'],
      text: string,
      edit: TaprootExpectedRevision,
    ]
  >;
  addQualifier: TaprootAsyncMethod<
    [
      id: TaprootEntityId,
      statementId: string,
      snak: TaprootSnak,
      text: string,
      edit: TaprootExpectedRevision,
    ]
  >;
  removeQualifier: TaprootAsyncMethod<
    [
      id: TaprootEntityId,
      statementId: string,
      property: TaprootPropertyId,
      ordinal: number,
      text: string,
      edit: TaprootExpectedRevision,
    ]
  >;
  addReference: TaprootAsyncMethod<
    [
      id: TaprootEntityId,
      statementId: string,
      reference: TaprootReference,
      text: string,
      edit: TaprootExpectedRevision,
    ]
  >;
  removeReference: TaprootAsyncMethod<
    [
      id: TaprootEntityId,
      statementId: string,
      hash: string,
      text: string,
      edit: TaprootExpectedRevision,
    ]
  >;
}

export interface TaprootAuthorizedReaderLike {
  getEntity: TaprootAsyncMethod<[id: TaprootEntityId], unknown>;
  searchEntities: TaprootAsyncMethod<
    [
      query: string,
      search?: {
        language?: string;
        limit?: number;
        includeDeleted?: boolean;
        cursor?: string;
      },
    ],
    unknown
  >;
}
