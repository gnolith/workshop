/** Runtime-neutral package identity. Runtime APIs use explicit subpaths. */
export const workshopPackage = {
  name: '@gnolith/workshop',
  version: '0.2.3',
  schemaVersion: 3,
} as const;

export type { WorkshopCapability, WorkshopPrincipal } from './protocol.js';
