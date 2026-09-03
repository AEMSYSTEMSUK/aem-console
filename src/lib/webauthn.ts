// WebAuthn (passkey) configuration for AEM Console
// Per @simplewebauthn/server v11+ API

export const rpName = 'AEM Console';
export const rpID = 'console.aemtech.co.uk';
export const origin = `https://${rpID}`;

// Challenge lifetime (5 min - WebAuthn flows complete in seconds)
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Session lifetime (7 days)
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
