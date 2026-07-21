import { WorkshopError } from '../protocol/errors.js';
import type { WorkshopCapability, WorkshopPrincipal } from '../protocol.js';

export function authorize(
  principal: WorkshopPrincipal | null,
  capability: WorkshopCapability,
): WorkshopPrincipal {
  if (!principal) {
    throw new WorkshopError('unauthenticated', 'Authentication is required');
  }
  if (
    !principal.capabilities.includes(capability) &&
    !principal.capabilities.includes('admin')
  ) {
    throw new WorkshopError('forbidden', `Missing ${capability} capability`);
  }
  return principal;
}
