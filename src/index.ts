/** Browser- and Worker-safe package identity. Runtime APIs use explicit subpaths. */
export const workshopPackage = {
  name: '@gnolith/workshop',
  version: '0.1.0',
  schemaVersion: 1,
} as const;

export type { WorkshopCapability, WorkshopPrincipal } from './protocol.js';
