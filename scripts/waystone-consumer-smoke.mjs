import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAndVerifyArtifact } from './artifact-provenance.mjs';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('consumer:check must be run through npm');

const source = JSON.parse(readFileSync('package.json', 'utf8'));
const publicWorkshopVersion = process.env.WORKSHOP_PUBLIC_CONSUMER_VERSION;
const workshopConsumerSpec = process.env.WORKSHOP_CONSUMER_SPEC;
if (publicWorkshopVersion !== undefined && workshopConsumerSpec !== undefined) {
  throw new Error(
    'Set only one of WORKSHOP_PUBLIC_CONSUMER_VERSION and WORKSHOP_CONSUMER_SPEC',
  );
}
if (
  publicWorkshopVersion !== undefined &&
  publicWorkshopVersion !== source.version
) {
  throw new Error(
    `Public Workshop consumer version ${publicWorkshopVersion} does not match ${source.version}`,
  );
}
const workshopSpec =
  publicWorkshopVersion ??
  workshopConsumerSpec ??
  (await loadAndVerifyArtifact()).archive;
const root = mkdtempSync(join(tmpdir(), 'workshop-waystone-consumer-'));
const waystoneIntegrity =
  'sha512-2lzNmfn9KZC1c47ydV9DO90QXixb6yScEBeh8kfI4KaNj2cXrWOyvZxnjjz/WFPF+jmy7YTRSmGRxTxh42oA6g==';

writeFileSync(
  join(root, 'package.json'),
  `${JSON.stringify(
    {
      private: true,
      type: 'module',
      dependencies: {
        '@gnolith/taproot': '0.4.0',
        '@gnolith/workshop': workshopSpec,
        '@gnolith/waystone': '0.2.0',
        '@types/react': '19.2.14',
        '@types/react-dom': '19.2.3',
        react: '19.2.7',
        'react-dom': '19.2.7',
        typescript: '5.9.3',
      },
    },
    null,
    2,
  )}\n`,
);

// Intentionally use normal npm resolution: no --force or --legacy-peer-deps.
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
  ],
  { stdio: 'inherit' },
);

const installedWorkshop = packageManifest('@gnolith/workshop');
const installedWaystone = packageManifest('@gnolith/waystone');
assert.equal(installedWorkshop.version, source.version);
assert.equal(installedWaystone.version, '0.2.0');
assert.equal(
  installedWorkshop.peerDependencies['@gnolith/waystone'],
  '>=0.1.0 <0.3.0',
);
assert.equal(installedWaystone.peerDependencies.react, '>=19 <20');

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
assert.equal(
  lock.packages['node_modules/@gnolith/waystone'].integrity,
  waystoneIntegrity,
  'Disposable consumer did not resolve the qualified public Waystone 0.2.0 artifact',
);

writeFileSync(
  join(root, 'declaration-probe.tsx'),
  `
    import { createWorkshopPlugin } from '@gnolith/workshop/ui';
    import type { WaystonePlugin as WorkshopPlugin } from '@gnolith/workshop/ui';
    import { createWaystoneRegistry } from '@gnolith/waystone/plugin';
    import type {
      WorkshopCompatibleWaystonePlugin,
      WaystonePluginInput,
      WaystoneRegistry,
    } from '@gnolith/waystone/plugin';

    const workshopPlugin: WorkshopPlugin = createWorkshopPlugin();
    const compatiblePlugin: WorkshopCompatibleWaystonePlugin = workshopPlugin;
    const pluginInput: WaystonePluginInput = compatiblePlugin;
    export const registry: WaystoneRegistry = createWaystoneRegistry([pluginInput]);
  `,
);
writeFileSync(
  join(root, 'tsconfig.json'),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['declaration-probe.tsx'],
    },
    null,
    2,
  )}\n`,
);
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    'tsconfig.json',
  ],
  { cwd: root, stdio: 'inherit' },
);

writeFileSync(
  join(root, 'plugin-probe.mjs'),
  `
    import assert from 'node:assert/strict';
    import { createWorkshopPlugin } from '@gnolith/workshop/ui';
    import { createWaystoneRegistry } from '@gnolith/waystone/plugin';

    const registry = createWaystoneRegistry([createWorkshopPlugin()]);
    assert.deepEqual(
      registry.plugins.map(({ id, label }) => ({ id, label })),
      [{ id: 'workshop', label: 'Workshop' }],
    );
    assert.deepEqual(
      registry.routeDescriptors.map(({ pluginId, contribution }) => ({
        pluginId,
        id: contribution.id,
        path: contribution.path,
        requiresClient: contribution.requiresClient,
      })),
      [
        {
          pluginId: 'workshop',
          id: 'workshop-memories-route',
          path: '/workshop/memories',
          requiresClient: true,
        },
        {
          pluginId: 'workshop',
          id: 'workshop-tasks-route',
          path: '/workshop/tasks',
          requiresClient: true,
        },
      ],
    );
    assert.deepEqual(
      registry.entityPanels.map(({ pluginId, contribution }) => ({
        pluginId,
        id: contribution.id,
        label: contribution.label,
      })),
      [
        {
          pluginId: 'workshop',
          id: 'workshop-related-tasks',
          label: 'Related tasks',
        },
      ],
    );
    const adaptedEntityPanel = registry.entityPanels[0].contribution.component({
      entity: { id: 'Q42' },
    });
    assert.equal(adaptedEntityPanel.props.entityId, 'Q42');
  `,
);
execFileSync(process.execPath, [join(root, 'plugin-probe.mjs')], {
  cwd: root,
  stdio: 'inherit',
});

console.log(
  `normal npm, declarations, and plugin registration passed for ` +
    `@gnolith/workshop@${source.version}, @gnolith/waystone@0.2.0, and React 19`,
);

function packageManifest(name) {
  return JSON.parse(
    readFileSync(
      join(root, 'node_modules', ...name.split('/'), 'package.json'),
      'utf8',
    ),
  );
}
