export interface TaprootReleaseVerificationOptions {
  fetchImpl?: (url: URL, init: { redirect: 'error' }) => Promise<Response>;
  verifyPackage?: () => Promise<void>;
}

export function verifyTaprootRelease(
  options?: TaprootReleaseVerificationOptions,
): Promise<{
  packageName: '@gnolith/taproot';
  version: '0.4.0';
  sourceCommit: '819fe054ebb867e1ca92518bfd3b1aa6c5aa277d';
}>;
