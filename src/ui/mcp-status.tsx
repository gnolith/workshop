export function McpStatusPanel({
  status,
  endpoint,
  detail,
}: {
  status: 'connected' | 'unavailable' | 'unauthorized' | 'unknown';
  endpoint?: string;
  detail?: string;
}) {
  return (
    <section className="workshop-panel">
      <h2>MCP endpoint</h2>
      <p>
        <span className={`workshop-badge workshop-mcp-${status}`}>
          {status}
        </span>
      </p>
      {endpoint ? <code>{endpoint}</code> : null}
      {detail ? <p>{detail}</p> : null}
    </section>
  );
}
