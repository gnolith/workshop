export interface TaprootReleaseVerificationOptions {
  fetchImpl?: (url: URL, init: { redirect: 'error' }) => Promise<Response>;
  verifyPackage?: () => Promise<void>;
}

export function verifyTaprootRelease(
  options?: TaprootReleaseVerificationOptions,
): Promise<{
  packageName: '@gnolith/taproot';
  version: '0.3.0';
  sourceCommit: '9b7eb5de694e6020ce8466e01687b8077fbf915c';
}>;
