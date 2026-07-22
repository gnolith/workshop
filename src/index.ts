/** Runtime-neutral package identity. Runtime APIs use explicit subpaths. */
export const workshopPackage = {
  name: '@gnolith/workshop',
  version: '0.4.1',
  schemaVersion: 6,
} as const;

export type { WorkshopCapability, WorkshopPrincipal } from './protocol.js';
