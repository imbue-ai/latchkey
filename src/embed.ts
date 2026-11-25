/**
 * Latchkey for a program that embeds it.
 *
 * This entry point is for a program that runs Latchkey inside its own process:
 * it holds the encryption key, owns the sockets, and extends the gateway with
 * handlers of its own. See docs/embedding.md.
 *
 * Importing it reads no environment variable and no file other than
 * Latchkey's own modules; everything it needs arrives as arguments. It is a
 * public interface of the package, held to semantic versioning.
 */

// The runtime: Latchkey's working state for one directory.
export {
  createLatchkeyRuntime,
  CurlCommandConflictError,
  InvalidRuntimeDirectoryError,
  UnknownRuntimeError,
  type LatchkeyRuntime,
  type LatchkeyRuntimeOptions,
  type LatchkeyRuntimeSettings,
} from './runtime.js';

// The gateway, as a request handler and as a server of its own.
export {
  createGatewayRequestHandler,
  startGateway,
  type GatewayRequestHandler,
  type GatewayRequestHandlerOptions,
  type GatewayServer,
  type GatewayServerOptions,
} from './gateway/server.js';
export {
  ExtensionLoadError,
  ExtensionStartError,
  loadExtensions,
  type ExtensionContext,
  type ExtensionHandler,
  type ExtensionLifecycleHook,
  type GatewayExtension,
} from './gateway/extensions.js';

// The gateway's headers, for a handler that reads or forwards a request.
export {
  GATEWAY_INTERNAL_HEADERS,
  GATEWAY_NO_CREDENTIALS_HEADER,
  HOP_BY_HOP_HEADERS,
} from './gateway/gatewayEndpoint.js';
export { GATEWAY_ACCOUNT_HEADER } from './gateway/account.js';
export { GATEWAY_PASSWORD_HEADER } from './gateway/password.js';

// Permissions-override tokens.
export {
  createPermissionsOverrideJwt,
  derivePermissionsOverrideSigningKey,
  InvalidPermissionsOverrideError,
  PERMISSIONS_OVERRIDE_HEADER,
  PermissionsOverrideFileMissingError,
  verifyPermissionsOverrideJwt,
} from './gateway/permissionsOverride.js';

// Credential operations.
export {
  AccountNotStoredError,
  BrowserStateNotFoundError,
  clearCredentials,
  DestinationCredentialsUnreadableError,
  DestinationDataFormatError,
  DestinationNotADirectoryError,
  InvalidDestinationKeyError,
  NothingToReencryptError,
  reencryptCredentials,
  ReencryptCredentialsError,
  ServicesNotStoredError,
  SourceCredentialsUnreadableError,
  type CredentialsLocation,
  type CredentialsSelection,
  type ReencryptCredentialsOptions,
  type ReencryptCredentialsResult,
} from './credentialOperations.js';
export {
  AccountNotFoundError,
  authList,
  servicesInfo,
  servicesList,
  UnknownServiceError,
  type AccountCredentialStatuses,
  type CredentialStatusEntry,
  type ServiceCapabilities,
  type ServicesInfoResult,
} from './sharedOperations.js';

// What the embedding process does for itself.
export { ignoreInspectorSignal } from './inspector.js';

// The building blocks a runtime is made of.
export { Config, CurlNotFoundError, InsecureFilePermissionsError } from './config.js';
export { decrypt, DecryptionError, encrypt, EncryptionError, generateKey } from './encryption.js';
export { EncryptedStorage, EncryptedStorageError } from './encryptedStorage.js';
export {
  AmbiguousAccountError,
  ApiCredentialStore,
  ApiCredentialStoreError,
} from './apiCredentials/store.js';
export type { ApiCredentials, ApiCredentialsType } from './apiCredentials/base.js';
export { ServiceRegistry } from './serviceRegistry.js';
export type { Service } from './services/index.js';
export { PluginLoadError } from './plugins.js';
export { MigrationError } from './migrations.js';
export { PermissionCheckError, type PermissionCheckMetadata } from './permissions.js';
