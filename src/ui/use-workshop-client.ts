import { useState } from 'react';
import { createWorkshopClient } from '../protocol/client.js';
import type { WorkshopClient } from '../protocol/client.js';
import type { WorkshopClientSource } from './configuration.js';

export function useWorkshopClient(
  source?: WorkshopClientSource,
): WorkshopClient {
  const [client] = useState(() =>
    typeof source === 'function'
      ? source()
      : (source ?? createWorkshopClient()),
  );
  return client;
}
