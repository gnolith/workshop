/** Runtime-neutral package identity. Runtime APIs use explicit subpaths. */
export const workshopPackage = {
  name: '@gnolith/workshop',
  version: '0.3.1',
  schemaVersion: 5,
} as const;

export type { WorkshopCapability, WorkshopPrincipal } from './protocol.js';
