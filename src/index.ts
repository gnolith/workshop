/** Runtime-neutral package identity. Runtime APIs use explicit subpaths. */
export const workshopPackage = {
  name: '@gnolith/workshop',
  version: '0.5.0',
  schemaVersion: 9,
} as const;

export type { WorkshopCapability, WorkshopPrincipal } from './protocol.js';
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
