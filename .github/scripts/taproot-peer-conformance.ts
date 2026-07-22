import {
  addAlias,
  addQualifier,
  addReference,
  addStatement,
  createItem,
  createProperty,
  createExternalSearchDomainMutationCoordinatorV1,
  createExternalSearchDomainPolicyAuthorityV1,
  createExternalSearchProducerGuardV1,
  removeAlias,
  removeQualifier,
  removeReference,
  removeSitelink,
  removeStatement,
  replaceStatement,
  setDescription,
  setLabel,
  setSitelink,
  setStatementRank,
  type AuthorizationContext as TaprootAuthorizationContext,
  type AuthorizedTaprootReader,
  type D1DatabaseLike,
  type InstallationAuthorizationGuard,
  type InstallationDomainMutationGuard,
  type TaprootWriteOptions,
  type TaprootHostWriteCapability,
  type VisibilityScopeV1 as TaprootVisibilityScope,
} from '@gnolith/taproot';
import type { AuthorizationContext as WorkshopAuthorizationContext } from '@gnolith/workshop/protocol';
import type {
  TaprootAuthorizedReaderLike,
  TaprootKnowledgeWriter,
  TaprootMutationReceipt,
  D1DatabaseLike as WorkshopD1DatabaseLike,
  D1PreparedStatementLike as WorkshopD1PreparedStatementLike,
  WorkshopAuthorizationAuthority,
  VisibilityScopeV1 as WorkshopVisibilityScope,
  WorkshopSearchIntegrationV1,
} from '@gnolith/workshop/server';
import { createWorkshopSearchIntegrationV1 } from '@gnolith/workshop/server';

declare const db: D1DatabaseLike;
declare const options: TaprootWriteOptions;
declare const guard: InstallationAuthorizationGuard;
declare const taskGuard: InstallationDomainMutationGuard;
declare const memoryGuard: InstallationDomainMutationGuard;
declare const taskBackfillGuard: InstallationDomainMutationGuard;
declare const memoryBackfillGuard: InstallationDomainMutationGuard;
declare const cursorSnapshotGuard: InstallationDomainMutationGuard;
declare const actualReader: AuthorizedTaprootReader;
declare const hostCapability: TaprootHostWriteCapability;
declare const installationId: string;
declare const taprootAuthorization: TaprootAuthorizationContext;
declare const workshopAuthorization: WorkshopAuthorizationContext;
declare const taprootVisibility: TaprootVisibilityScope;
declare const workshopVisibility: WorkshopVisibilityScope;

const workshopAuthority: WorkshopAuthorizationAuthority = {
  getInstallationAuthorizationState: () => taskGuard.readCurrentState(),
  async commitTaskMutation<T>(
    _db: WorkshopD1DatabaseLike,
    context: WorkshopAuthorizationContext,
    mutation: WorkshopD1PreparedStatementLike,
  ): Promise<T | null> {
    const result = await taskGuard.batchWithExpectedRevision(context, [
      mutation,
    ]);
    return (result.results[0]?.results?.[0] as T | undefined) ?? null;
  },
  async commitMemoryMutation<T>(
    _db: WorkshopD1DatabaseLike,
    context: WorkshopAuthorizationContext,
    mutation: WorkshopD1PreparedStatementLike,
  ): Promise<T | null> {
    const result = await memoryGuard.batchWithExpectedRevision(context, [
      mutation,
    ]);
    return (result.results[0]?.results?.[0] as T | undefined) ?? null;
  },
  async commitTaskBackfill(_db, context, _state, mutations) {
    const result = await taskBackfillGuard.batchWithExpectedRevision(
      context,
      mutations,
    );
    return result.results;
  },
  async commitMemoryBackfill(_db, context, _state, mutations) {
    const result = await memoryBackfillGuard.batchWithExpectedRevision(
      context,
      mutations,
    );
    return result.results;
  },
  async commitCursorSnapshot(_db, context, _state, mutations) {
    const result = await cursorSnapshotGuard.batchWithExpectedRevision(
      context,
      mutations,
    );
    return result.results;
  },
};

const reader: TaprootAuthorizedReaderLike = actualReader;
const searchIntegration: Promise<WorkshopSearchIntegrationV1> =
  createWorkshopSearchIntegrationV1({
    db: db as unknown as WorkshopD1DatabaseLike,
    taproot: options,
    hostCapability,
    installationId,
    registrationContext: workshopAuthorization,
  });
const producerFactories = [
  createExternalSearchDomainMutationCoordinatorV1,
  createExternalSearchDomainPolicyAuthorityV1,
  createExternalSearchProducerGuardV1,
] as const;
const writer = {
  createItem: (input) =>
    createItem(db, options, guard, taprootAuthorization, input),
  createProperty: (input) =>
    createProperty(db, options, guard, taprootAuthorization, input),
  setLabel: (...args) =>
    setLabel(db, options, guard, taprootAuthorization, ...args),
  setDescription: (...args) =>
    setDescription(db, options, guard, taprootAuthorization, ...args),
  addAlias: (...args) =>
    addAlias(db, options, guard, taprootAuthorization, ...args),
  removeAlias: (...args) =>
    removeAlias(db, options, guard, taprootAuthorization, ...args),
  setSitelink: (...args) =>
    setSitelink(db, options, guard, taprootAuthorization, ...args),
  removeSitelink: (...args) =>
    removeSitelink(db, options, guard, taprootAuthorization, ...args),
  addStatement: (...args) =>
    addStatement(db, options, guard, taprootAuthorization, ...args),
  replaceStatement: (...args) =>
    replaceStatement(db, options, guard, taprootAuthorization, ...args),
  removeStatement: (...args) =>
    removeStatement(db, options, guard, taprootAuthorization, ...args),
  setStatementRank: (...args) =>
    setStatementRank(db, options, guard, taprootAuthorization, ...args),
  addQualifier: (...args) =>
    addQualifier(db, options, guard, taprootAuthorization, ...args),
  removeQualifier: (...args) =>
    removeQualifier(db, options, guard, taprootAuthorization, ...args),
  addReference: (...args) =>
    addReference(db, options, guard, taprootAuthorization, ...args),
  removeReference: (...args) =>
    removeReference(db, options, guard, taprootAuthorization, ...args),
} satisfies TaprootKnowledgeWriter;

const authorizationToWorkshop: WorkshopAuthorizationContext =
  taprootAuthorization;
const authorizationToTaproot: TaprootAuthorizationContext =
  workshopAuthorization;
const visibilityToWorkshop: WorkshopVisibilityScope = taprootVisibility;
const visibilityToTaproot: TaprootVisibilityScope = workshopVisibility;
type ActualReceipt = Awaited<ReturnType<typeof writer.createItem>>;
const receiptCompatible: ActualReceipt extends TaprootMutationReceipt
  ? true
  : false = true;
type RawReadKeys = Extract<
  keyof TaprootKnowledgeWriter,
  'getEntity' | 'getEntityRevision' | 'searchEntities' | 'searchEntitiesPage'
>;
const noRawReads: RawReadKeys extends never ? true : false = true;
const noDeepWriteResult: 'entity' extends keyof TaprootMutationReceipt
  ? false
  : true = true;

void [
  reader,
  workshopAuthority,
  authorizationToWorkshop,
  authorizationToTaproot,
  visibilityToWorkshop,
  visibilityToTaproot,
  receiptCompatible,
  noRawReads,
  noDeepWriteResult,
  searchIntegration,
  producerFactories,
];
