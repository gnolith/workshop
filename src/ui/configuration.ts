import type {
  OnboardingSeedInput,
  OnboardingSeedPlan,
  OnboardingSeedResult,
} from '../protocol/onboarding.js';
import type { WorkshopClient } from '../protocol/client.js';
import type { WorkshopCapability } from '../protocol.js';

export type WorkshopClientSource = WorkshopClient | (() => WorkshopClient);

export interface WorkshopMcpStatus {
  status: 'connected' | 'unavailable' | 'unauthorized' | 'unknown';
  endpoint?: string;
  detail?: string;
}

export interface WorkshopOnboardingController {
  preview(input: OnboardingSeedInput): Promise<OnboardingSeedPlan>;
  apply(plan: OnboardingSeedPlan): Promise<OnboardingSeedResult>;
}

export interface WorkshopUiOptions {
  client?: WorkshopClientSource;
  capabilities?: readonly WorkshopCapability[];
  onboarding?: WorkshopOnboardingController;
  loadMcpStatus?: () => Promise<WorkshopMcpStatus>;
}

export function hasUiCapability(
  capabilities: readonly WorkshopCapability[],
  capability: WorkshopCapability,
): boolean {
  return capabilities.includes(capability) || capabilities.includes('admin');
}
