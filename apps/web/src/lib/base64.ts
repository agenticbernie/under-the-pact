/**
 * Browser-safe base64 (Qodo/Codex PR #13: Node's Buffer global does not
 * exist in the deployed Astro browser runtime). Web APIs only — no polyfill
 * needed for these two helpers. web3.js internals still need the Buffer
 * polyfill installed at the island entry (see SigningPanel).
 */

export const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};
