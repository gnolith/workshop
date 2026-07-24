export {
  GNOLITH_MCP_PROTOCOL_VERSION,
  createGnolithMcpServer,
  type GnolithMcpServer,
  type GnolithMcpServerOptions,
} from './mcp/server.js';
export {
  CATALOG_DIGEST,
  OPERATION_SCHEMA_VERSION,
  operationCatalog,
  type OperationName,
} from './generated/operations.js';
