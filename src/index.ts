/**
 * dario — programmatic API
 *
 * Use this if you want to embed dario in your own app
 * instead of running the CLI.
 */

export { startOAuthFlow, exchangeCode, refreshTokens, getAccessToken, getStatus, loadCredentials } from './oauth.js';
export type { OAuthTokens, CredentialsFile } from './oauth.js';
export { startProxy } from './proxy.js';
