/**
 * Latchkey - A CLI tool that injects API credentials into curl requests.
 */

// Core types and utilities
export {
  ApiCredentials,
  ApiCredentialStatus,
  AuthorizationBearer,
  AuthorizationBare,
  SlackApiCredentials,
  deserializeCredentials,
  serializeCredentials,
} from './apiCredentials.js';

export { ApiCredentialStore, ApiCredentialStoreError } from './apiCredentialStore.js';

export { BrowserStateStore, BrowserStateError } from './browserState.js';

export { Config, CONFIG } from './config.js';

export { encrypt, decrypt, generateKey, EncryptionError, DecryptionError } from './encryption.js';

export {
  EncryptedStorage,
  EncryptedStorageError,
  InsecureFilePermissionsError,
} from './encryptedStorage.js';

export {
  storeInKeychain,
  retrieveFromKeychain,
  deleteFromKeychain,
  isKeychainAvailable,
  KeychainError,
  KeychainNotAvailableError,
} from './keychain.js';

export {
  run as runCurl,
  runCaptured as runCurlCaptured,
  setSubprocessRunner,
  resetSubprocessRunner,
  setCapturingSubprocessRunner,
  resetCapturingSubprocessRunner,
} from './curl.js';

export { typeLikeHuman } from './playwrightUtils.js';

// Services
export {
  Service,
  ServiceSession,
  SimpleServiceSession,
  BrowserFollowupServiceSession,
  LoginCancelledError,
  LoginFailedError,
  Slack,
  SLACK,
  Discord,
  DISCORD,
  Github,
  GITHUB,
  Dropbox,
  DROPBOX,
  Linear,
  LINEAR,
} from './services/index.js';

// Registry
export { Registry, REGISTRY } from './registry.js';
