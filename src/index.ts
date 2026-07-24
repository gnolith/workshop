/** Runtime-neutral package identity. Runtime APIs use explicit subpaths. */
export const workshopPackage = {
  name: '@gnolith/workshop',
  version: '0.5.0',
  schemaVersion: 8,
} as const;

export type { WorkshopCapability, WorkshopPrincipal } from './protocol.js';
export {
  createOperationRuntime,
  type OperationRuntime,
  type OperationRuntimeOptions,
} from './operations.js';
