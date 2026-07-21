import { loadAndVerifyArtifact } from './artifact-provenance.mjs';

const { archive } = await loadAndVerifyArtifact();
console.log(archive);
