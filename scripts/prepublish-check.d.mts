export interface PublishDryRunBoundaryInput {
  status: number | null;
  output: string;
  tag: string;
  head: string;
  tagType: string | null;
  tagCommit: string | null;
}

export function assertPublishDryRunBoundary(
  input: PublishDryRunBoundaryInput,
): 'tagged' | 'untagged';
