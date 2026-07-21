import { loadAndVerifyArtifact } from './artifact-provenance.mjs';

const { archive, provenance } = await loadAndVerifyArtifact();
console.log(
  `verified ${archive} (${provenance.artifact.sha256}, ${provenance.artifact.files.length} files)`,
);
