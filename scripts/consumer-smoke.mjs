import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAndVerifyArtifact } from './artifact-provenance.mjs';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('consumer:check must be run through npm');
const projectRoot = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'workshop-consumer-'));
const source = JSON.parse(readFileSync('package.json', 'utf8'));
const { archive } = await loadAndVerifyArtifact();
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      '@cloudflare/vite-plugin': '1.45.1',
      '@vitejs/plugin-react': '6.0.3',
      '@vitejs/plugin-rsc': '0.5.28',
      react: '19.2.7',
      'react-dom': '19.2.7',
      'react-server-dom-webpack': '19.2.7',
      vinext: '1.0.0-beta.2',
      vite: '8.1.5',
      wrangler: '4.112.0',
    },
  }),
);
execFileSync(
  process.execPath,
  [
    npmCli,
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
    root,
    archive,
  ],
  { stdio: 'inherit' },
);
writeFileSync(
  join(root, 'smoke.mjs'),
  `
    import { workshopPackage } from '@gnolith/workshop';
    import { createWorkshopClient, taskState } from '@gnolith/workshop/protocol';
    import { createWorkshopRuntime, TaskService } from '@gnolith/workshop/server';
    import { createWorkshopMcpServer, workshopTools } from '@gnolith/workshop/mcp';
    import { createWorkshopMcpHandler } from '@gnolith/workshop/site';
    import { workshopMigrations } from '@gnolith/workshop/migrations';
    import { createWorkshopPlugin, workshopPlugin, TaskList, WorkshopTasksScreen } from '@gnolith/workshop/ui';
    const values = [workshopPackage, createWorkshopClient, taskState, createWorkshopRuntime,
      TaskService, createWorkshopMcpServer, workshopTools, createWorkshopMcpHandler,
      workshopMigrations, createWorkshopPlugin, workshopPlugin, TaskList, WorkshopTasksScreen];
    if (values.some((value) => value === undefined)) throw new Error('Public export missing');
  `,
);
execFileSync(process.execPath, [join(root, 'smoke.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
const packageRoot = join(root, 'node_modules', ...source.name.split('/'));
for (const path of [
  'dist/index.d.ts',
  'dist/protocol.d.ts',
  'dist/server.d.ts',
  'dist/mcp.d.ts',
  'dist/site.d.ts',
  'dist/ui.d.ts',
  'dist/migrations.d.ts',
  'dist/styles.css',
  'migrations/0001_workshop.sql',
  'SECURITY.md',
]) {
  if (!existsSync(join(packageRoot, path))) {
    throw new Error(`Packed package is missing ${path}`);
  }
}
const packedPaths = readdirSync(packageRoot, {
  recursive: true,
  withFileTypes: true,
}).map((entry) => join(entry.parentPath, entry.name));
for (const forbidden of ['.wrangler', join('dist', 'server', 'diamond.js')]) {
  if (packedPaths.some((path) => path.includes(forbidden))) {
    throw new Error(
      `Packed package contains forbidden stale output: ${forbidden}`,
    );
  }
}
const canaryRoot = join(root, 'package-runtime-canary');
writeFileSync(
  join(root, 'worker.ts'),
  readFileSync('examples/package-runtime-canary/worker.ts', 'utf8'),
);
writeFileSync(
  join(root, 'wrangler.jsonc'),
  readFileSync('examples/package-runtime-canary/wrangler.jsonc', 'utf8'),
);
const wranglerOutput = execFileSync(
  process.execPath,
  [
    join(projectRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    'deploy',
    '--dry-run',
    '--config',
    join(root, 'wrangler.jsonc'),
    '--outdir',
    canaryRoot,
  ],
  { cwd: root, encoding: 'utf8' },
);
if (/node:events|nodejs_compat/iu.test(wranglerOutput)) {
  throw new Error(
    'Isolated exact-tarball Worker consumer pulled Node compatibility requirements',
  );
}
if (!existsSync(join(canaryRoot, 'worker.js'))) {
  throw new Error(
    'Isolated exact-tarball Worker consumer did not produce a bundle',
  );
}

const appRoot = join(root, 'app');
const mcpRouteRoot = join(appRoot, 'api', 'workshop', 'mcp');
mkdirSync(mcpRouteRoot, { recursive: true });
writeFileSync(
  join(appRoot, 'layout.tsx'),
  `
    import type { ReactNode } from 'react';
    import '@gnolith/workshop/styles.css';
    export default function Layout({ children }: { children: ReactNode }) {
      return <html lang="en"><body>{children}</body></html>;
    }
  `,
);
writeFileSync(
  join(appRoot, 'page.tsx'),
  `
    import { McpStatusPanel, TaskList, WorkshopDashboard } from '@gnolith/workshop/ui';
    const task = {
      id: 'canary-task', description: 'Canary task', prompt: 'Verify Workshop UI.',
      contextQueries: [], memorySlugs: [], claimed: false,
      createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z',
    };
    export default function Page() {
      return <main><WorkshopDashboard tasks={[task]} memories={[]} />
        <TaskList tasks={[task]} /><McpStatusPanel status="connected" endpoint="/api/workshop/mcp" /></main>;
    }
  `,
);
writeFileSync(
  join(mcpRouteRoot, 'route.ts'),
  `
    import { env } from 'cloudflare:workers';
    import { createWorkshopRuntime } from '@gnolith/workshop/server';
    import { createWorkshopMcpHandler } from '@gnolith/workshop/site';
    type Bindings = { DB: import('@gnolith/workshop/server').D1DatabaseLike; WORKSHOP_TOKEN?: string };
    const handler = (request: Request) => {
      const bindings = env as unknown as Bindings;
      const runtime = createWorkshopRuntime({
        db: bindings.DB,
        executeSparql: async () => ({ type: 'boolean', data: true, truncated: false }),
        knowledge: { call: async () => ({}), health: async () => true },
        resolvePrincipal: async (candidate) => candidate.headers.get('authorization') ===
          \`Bearer \${bindings.WORKSHOP_TOKEN ?? 'canary'}\` ? {
            id: 'canary', capabilities: ['read', 'task-write', 'memory-write', 'knowledge-write', 'admin'],
          } : null,
      });
      return createWorkshopMcpHandler(runtime)(request);
    };
    export const GET = handler;
    export const POST = handler;
  `,
);
writeFileSync(
  join(root, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      jsx: 'react-jsx',
      strict: true,
      skipLibCheck: true,
    },
    include: ['app'],
  }),
);
writeFileSync(
  join(root, 'vite.config.ts'),
  `
    import { cloudflare } from '@cloudflare/vite-plugin';
    import { defineConfig } from 'vite';
    import vinext from 'vinext';
    export default defineConfig({
      plugins: [
        vinext(),
        cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] } }),
      ],
    });
  `,
);
execFileSync(
  process.execPath,
  [join(root, 'node_modules', 'vinext', 'dist', 'cli.js'), 'build'],
  { cwd: root, stdio: 'inherit' },
);
if (!existsSync(join(root, 'dist'))) {
  throw new Error('Isolated vinext exact-tarball consumer did not build');
}
console.log(
  `generic, Worker, and vinext isolated package consumers passed for ${source.name}@${source.version}`,
);
