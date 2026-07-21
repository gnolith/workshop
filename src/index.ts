/** Runtime-neutral package identity. Runtime APIs use explicit subpaths. */
export const workshopPackage = {
  name: '@gnolith/workshop',
  version: '0.1.1',
  schemaVersion: 1,
} as const;

export type { WorkshopCapability, WorkshopPrincipal } from './protocol.js';
