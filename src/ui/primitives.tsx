import type { ReactNode } from 'react';
import type { WorkshopCapability } from '../protocol.js';

export function PermissionNotice({
  capability,
}: {
  capability: WorkshopCapability;
}) {
  return (
    <p className="workshop-notice" role="status">
      You do not have the <code>{capability}</code> capability required for this
      action.
    </p>
  );
}

export function SafeText({ children }: { children: string }) {
  return <div className="workshop-text">{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="workshop-empty">{children}</p>;
}
