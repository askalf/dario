/**
 * dario — programmatic API
 *
 * Use this if you want to embed dario in your own app
 * instead of running the CLI.
 */

export { startAutoOAuthFlow, refreshTokens, getAccessToken, getStatus, loadCredentials } from './oauth.js';
export type { OAuthTokens, CredentialsFile } from './oauth.js';
export { startProxy, sanitizeError } from './proxy.js';
