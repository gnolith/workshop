import type { WorkshopClient } from '../protocol/client.js';
import { hasWorkshopCapability, type WorkshopCapability } from '../protocol.js';

export type WorkshopClientSource = WorkshopClient | (() => WorkshopClient);

export interface WorkshopMcpStatus {
  status: 'connected' | 'unavailable' | 'unauthorized' | 'unknown';
  endpoint?: string;
  detail?: string;
}

export interface WorkshopUiOptions {
  client?: WorkshopClientSource;
  capabilities?: readonly WorkshopCapability[];
  loadMcpStatus?: () => Promise<WorkshopMcpStatus>;
}

export function hasUiCapability(
  capabilities: readonly WorkshopCapability[],
  capability: WorkshopCapability,
): boolean {
  return hasWorkshopCapability(capabilities, capability);
}
