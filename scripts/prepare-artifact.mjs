import { prepareArtifact } from './artifact-provenance.mjs';

const { archive, provenance } = prepareArtifact();
console.log(
  JSON.stringify({
    archive,
    sha256: provenance.artifact.sha256,
    integrity: provenance.artifact.integrity,
    files: provenance.artifact.files.length,
    commit: provenance.source.commit,
    dirty: provenance.source.dirty,
  }),
);
