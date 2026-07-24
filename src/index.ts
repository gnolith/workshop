/** Runtime-neutral package identity. Runtime APIs use explicit subpaths. */
export const workshopPackage = {
  name: '@gnolith/workshop',
  version: '0.5.0',
  schemaVersion: 11,
} as const;

export type { WorkshopCapability, WorkshopPrincipal } from './protocol.js';
export {
  configureWorkshopSemanticsV1,
  readWorkshopSemanticStatusV1,
  type ConfigureWorkshopSemanticsV1Dependencies,
  type ConfigureWorkshopSemanticsV1Input,
  type ConfigureWorkshopSemanticsV1Receipt,
  type WorkshopSemanticStatusV1,
} from './semantic-configuration.js';
export {
  createWorkshopAuthorizationAdministrationV1,
  type WorkshopAuthorizationAdministrationOptionsV1,
  type WorkshopAuthorizationAdministrationV1,
} from './authorization-administration.js';
export {
  createOperationRuntime,
  type OperationRuntime,
  type OperationRuntimeOptions,
} from './operations.js';
export { createWorkshopDomainOperationPortV1 } from './domain-operation.js';
export {
  createWorkshopTaprootOperationPortV1,
  type WorkshopTaprootAssemblyOptionsV1,
} from './taproot-operation.js';
