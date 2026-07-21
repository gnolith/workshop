import { useId } from 'react';
import useSWR from 'swr';
import type { WorkshopMcpStatus } from './configuration.js';
import { WorkshopErrorNotice } from './error-notice.js';
import { WorkshopLoadingStatus } from './loading-status.js';
import { McpStatusPanel } from './mcp-status.js';

const unconfigured: WorkshopMcpStatus = {
  status: 'unknown',
  detail: 'The Site host has not configured an MCP status check.',
};

export function WorkshopMcpStatusScreen({
  loadStatus,
}: {
  loadStatus?: () => Promise<WorkshopMcpStatus>;
}) {
  const instance = useId();
  const status = useSWR<WorkshopMcpStatus, Error>(
    loadStatus ? `workshop-mcp-status:${instance}` : null,
    async () => {
      if (loadStatus === undefined) {
        throw new Error('No MCP status loader is configured.');
      }
      return loadStatus();
    },
  );
  if (!loadStatus) return <McpStatusPanel {...unconfigured} />;
  if (status.isLoading)
    return <WorkshopLoadingStatus label="Checking Workshop MCP…" />;
  if (status.error) return <WorkshopErrorNotice error={status.error} />;
  return (
    <div className="workshop-stack">
      <McpStatusPanel {...(status.data ?? unconfigured)} />
      <button type="button" onClick={() => void status.mutate()}>
        Check again
      </button>
    </div>
  );
}
