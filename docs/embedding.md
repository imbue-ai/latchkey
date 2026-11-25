# Embedding Latchkey

Latchkey can run inside another program's process.
The program holds the encryption key, owns the sockets, and extends the
gateway with handlers of its own, where `latchkey gateway` takes all three
from the environment and from files on disk.

Everything described here is exported from `latchkey/embed`:

```ts
import { createLatchkeyRuntime, createGatewayRequestHandler } from 'latchkey/embed';
```

`latchkey/embed` is a public interface of the package and follows semantic
versioning. Importing it reads no environment variable and no file other than
Latchkey's own modules: what it needs arrives as arguments.


## A runtime

A runtime is Latchkey's working state for one directory: its settings, its
credential store, and the services and credential types of Latchkey and of
the directory's [plugins](plugins.md).

```ts
const runtime = await createLatchkeyRuntime({
  directory: '/var/lib/myapp/latchkey', // absolute
  encryptionKey, // 32 bytes, base64; generateKey() makes one
  settings: { passthroughUnknown: true },
  log: (message) => logger.info(message),
  errorLog: (message) => logger.error(message),
});
```

The key is the one the directory's credential store is encrypted with.
The keychain is never consulted.

Each setting is one the command line reads from an environment variable, and
means what that variable means:

| Setting | Variable of the command line |
|---|---|
| `curlCommand` | `LATCHKEY_CURL` |
| `permissionsConfigPath` | `LATCHKEY_PERMISSIONS_CONFIG` |
| `permissionsDoNotUseBuiltinSchemas` | `LATCHKEY_PERMISSIONS_DO_NOT_USE_BUILTIN_SCHEMAS` |
| `passthroughUnknown` | `LATCHKEY_PASSTHROUGH_UNKNOWN` |
| `diagnosticHeaders` | `LATCHKEY_DIAGNOSTIC_HEADERS` |
| `credentialsRefreshDisabled` | `LATCHKEY_DISABLE_CREDENTIALS_REFRESH` |
| `hideBuiltinServices` | `LATCHKEY_HIDE_BUILTIN_SERVICES` |
| `browserDisabled` | `LATCHKEY_DISABLE_BROWSER` |
| `browserEphemeral` | `LATCHKEY_EPHEMERAL_BROWSER` |
| `appNamePrefix` | `LATCHKEY_APP_NAME_PREFIX` |

A setting you leave out takes the value of the `settings` section of the
directory's `config.json`, and the default when that names none. No
environment variable is consulted. The services registered in `config.json`
are read for every request, so registering one takes effect without a restart.

Creating a runtime does these in order, and throws the named error at the
first that fails:

1. validates the key (`EncryptionError`), after refusing a directory whose
   path is not absolute (`InvalidRuntimeDirectoryError`);
2. checks that `curl` can be found (`CurlNotFoundError`);
3. checks that the credential store and the browser state, when they exist,
   are readable by their owner only (`InsecureFilePermissionsError`);
4. loads the directory's plugins (`PluginLoadError`);
5. runs the migrations of the directory's data format (`MigrationError`),
   as every run of the command line does.

It does not open a credential store that is in the newest data format, so a
key that cannot decrypt the store is found by the first operation that reads
it (`ApiCredentialStoreError`). Call `runtime.apiCredentialStore.getAll()` if
you want to know up front. A store in an older format has to be read to be
migrated, and a key that cannot decrypt that one fails the creation with
`EncryptedStorageError`. It never sends the usage ping.

A runtime gives you the pieces the rest of Latchkey's functions take:
`runtime.config`, `runtime.apiCredentialStore`, `runtime.encryptedStorage`,
and `runtime.createServiceRegistry()`, which builds a registry from
`config.json` as it reads now.

```ts
import { servicesInfo } from 'latchkey/embed';

const info = await servicesInfo(
  runtime.createServiceRegistry(),
  runtime.apiCredentialStore,
  runtime.config,
  'slack'
);
```

A process may create runtimes for several directories. They share one `curl`
program: Latchkey's services run `curl` from places that hold no settings, so
its name is a value of the process, and creating a runtime that names a
different one throws `CurlCommandConflictError`.


## The gateway

The gateway is a request handler. You create the server.

```ts
import * as http from 'node:http';

const gateway = createGatewayRequestHandler(runtime, {
  password: gatewayPassword, // or null for none
  maxBodySize: 10 * 1024 * 1024,
  extensions: [],
});
await gateway.start();

const server = http.createServer(gateway.handleRequest);
server.listen(1989, '127.0.0.1');
```

`handleRequest` serves what `latchkey gateway` serves, with the same answers:
the password check, `GET /`, the `/latchkey/` endpoint, the `/gateway/<url>`
proxy, and the extensions.

`startGateway(runtime, { ...options, host, port })` creates the server for
you, for a program that wants one listener and nothing more. It is what the
`gateway` command uses.

Permissions-override tokens are verified with a key derived from the
runtime's encryption key. A program that hands tokens out mints them with the
same key:

```ts
import { createPermissionsOverrideJwt, derivePermissionsOverrideSigningKey } from 'latchkey/embed';

const token = createPermissionsOverrideJwt(
  '/var/lib/myapp/agents/7/permissions.json',
  derivePermissionsOverrideSigningKey(encryptionKey)
);
```


## Extensions as values

An extension passed to the handler has the contract an
[extension file](extensions.md) has, held in a value:

```ts
import type { GatewayExtension } from 'latchkey/embed';

const accounts: GatewayExtension = {
  name: 'accounts',
  handler: (request, response, context) => {
    if (request.method !== 'GET' || request.url !== '/extensions/myapp/accounts') {
      return false;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(runtime.apiCredentialStore.listAccounts('slack')));
    return true;
  },
};
```

A request reaches it the way it reaches an extension file: after the password
check and after the permission check against `latchkey-self.invalid`, with
the same `context`. What a value can do that a file cannot is close over
whatever its creator holds, the runtime included, which is how it reaches the
credential store.

The handler loads no extension from disk. To also serve the files of a
directory, as `latchkey gateway` does, load them and pass them:

```ts
import { loadExtensions } from 'latchkey/embed';

const extensions = [accounts, ...(await loadExtensions(runtime.config.extensionsDirectoryPath))];
```

A permission check for a request that Latchkey injects credentials into is
told the account, as always. Every other check has no account: a request
offered to the extensions, and a proxied request that carries its own
credentials. Pass `defaultPermissionCheckMetadata` to give those checks a
`customMetadata` of your own. When you pass none, Latchkey passes none, and
the permission library reads `DETENT_CUSTOM_METADATA` from the environment.

The gateway's own header names and sets are exported for a handler that reads
or forwards a request: `GATEWAY_PASSWORD_HEADER`, `PERMISSIONS_OVERRIDE_HEADER`,
`GATEWAY_ACCOUNT_HEADER`, `GATEWAY_NO_CREDENTIALS_HEADER`,
`GATEWAY_INTERNAL_HEADERS` and `HOP_BY_HOP_HEADERS`.


## Stopping

```ts
server.close();
await gateway.stop({ deadlineMilliseconds: 10_000 });
```

- Every call returns the promise of the first.
- From the first call, a new request is answered `503`. Stop accepting
  connections first; this covers a request that arrives on a connection that
  was already open.
- Each extension's `stop` is called, in order. An extension that keeps a
  response open ends it there.
- The requests in flight are given until the deadline. Then the `curl`
  process of every proxied request that has not finished is killed, and every
  response still open is destroyed.
- The promise resolves when no request is being handled any more. A handler
  that has still not returned a few seconds after its request was ended is
  reported through `errorLog` and no longer waited for.

`stop` closes no socket, because the handler owns none.


## Credential operations

Two commands are also functions. Neither prints, prompts or exits; each
reports a failure by throwing.

```ts
import { clearCredentials, reencryptCredentials } from 'latchkey/embed';

// latchkey auth clear slack --account work
clearCredentials(runtime, 'slack', { kind: 'account', account: 'work' });

// latchkey auth clear slack --all
clearCredentials(runtime, 'slack', { kind: 'allAccounts' });

// latchkey auth re-encrypt <destination> --services slack
await reencryptCredentials({
  source: { directory: bundleDirectory, encryptionKey: bundleKey },
  destination: { directory: runtime.config.directory, encryptionKey },
  apiCredentialsTypes: runtime.apiCredentialsTypes,
  services: ['slack'],
});
```

`reencryptCredentials` keeps an existing store in the destination and adds the
selected services to it, which makes it the way to merge credentials from
another directory into a runtime's own. Like the command, it first migrates
the source directory in place when that is in an older data format. Every
condition it refuses is a subclass of `ReencryptCredentialsError`.


## What your process does for itself

A library does not own the process it runs in. `latchkey/embed` installs no
signal handler, never exits the process, and writes to no stream: everything
it has to say goes to the `log` and `errorLog` you gave the runtime.

Your process therefore does what the command line does for itself:

- **Ignore `SIGUSR1`.** Node.js answers that signal by opening its inspector,
  through which any process of the same user could read the decrypted
  credentials. Call `ignoreInspectorSignal()` before anything else.
- **Handle `SIGINT` and `SIGTERM`.** Stop accepting connections, call
  `stop` with a deadline of your choosing, and exit.
- **Decide what a failure to start means.** `createLatchkeyRuntime` and the
  handler's `start` throw; whether to exit, retry or run without what failed
  is up to you.

A `curl` process Latchkey starts inherits your process's environment.
