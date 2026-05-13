# Gateway extensions

You can extend the gateway with your own HTTP endpoints.
At startup, `latchkey gateway` scans `~/.latchkey/extensions/` (or the corresponding alternative if you override `LATCHKEY_DIRECTORY`) for
files ending in `.mjs` (in alphabetical order) and dynamically
imports each one. Every module's default export must be a
function with the signature
`(request, response, context) => boolean | Promise<boolean>`:

- Return `true` (or a promise resolving to `true`) when the
  extension has handled the request — i.e. it has written, or
  will write, the full response. The gateway will not consult
  any further extensions.
- Return `false` to defer to the next extension. In that case
  the handler must not touch the response.

If no extension claims the request, the gateway responds with
`404`.

```js
// ~/.latchkey/extensions/hello.mjs
export default (request, response) => {
  if (request.method === 'GET' && request.url === '/extensions/myorg/hello') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ greeting: 'hello' }));
    return true;
  }
  return false;
};
```

- The handler receives Node's raw `http.IncomingMessage` and
  `http.ServerResponse`. Extensions cannot read stored
  credentials, the curl-injection pipeline, or the service
  registry.
- The third argument is a frozen `ExtensionContext` object
  carrying per-request state derived by the gateway. Handlers
  that don't need it can omit the parameter. Currently it
  exposes:
  - `permissionsConfigPath: string` — absolute path to the
    `permissions.json` file that applies to this request after
    resolving any `X-Latchkey-Gateway-Permissions-Override` JWT.
    Equals the gateway's default permissions path when no
    override header was sent (rejected overrides never reach
    the handler).

Extension requests are gated by `permissions.json` like every
other gateway request. The check happens before any extension
is offered the request: Latchkey synthesises a request using the
inbound method, path, query string, and headers, but with
a fixed placeholder URL host (`https://latchkey-self.invalid:1`)
representing "this gateway".

The placeholder host uses RFC 2606's reserved `.invalid` TLD, so
it can never collide with a real outbound rule. To write rules
that target extension endpoints, [define Detent
schemas](https://github.com/imbue-ai/detent#request-schemas)
that match on `domain: "latchkey-self.invalid"`. Detent
normalizes `domain` and `method` field values before matching,
so the schema must use lowercase domains and uppercase methods.

When `LATCHKEY_GATEWAY` is set, `latchkey curl` also rewrites URLs
whose host is `latchkey-self.invalid` directly onto the configured
gateway URL, so agents can invoke extensions with the same
placeholder host that appears in `permissions.json`:

```bash
LATCHKEY_GATEWAY=http://127.0.0.1:5555 \
  latchkey curl https://latchkey-self.invalid/extensions/myorg/hello
# actually calls: http://127.0.0.1:5555/extensions/myorg/hello
```

Unlike outbound URLs, these requests are not routed through the
gateway's `/gateway/<target>` proxy endpoint - they hit the gateway
directly and are dispatched to the matching extension.

Here's an example `permissions.json` that allows only
`GET /extensions/myorg/hello` on the gateway and rejects every
other extension call:

```json
{
  "schemas": {
    "latchkey-self": {
      "properties": {
        "domain": { "const": "latchkey-self.invalid" }
      },
      "required": ["domain"]
    },
    "myorg-hello": {
      "properties": {
        "method": { "const": "GET" },
        "path": { "const": "/extensions/myorg/hello" }
      },
      "required": ["method", "path"]
    }
  },
  "rules": [
    { "latchkey-self": ["myorg-hello"] }
  ]
}
```

How this works (see [Detent's rule resolution docs](https://github.com/imbue-ai/detent#rule-resolution-default-outcomes)
for the full picture):

- The `latchkey-self` schema is the scope - it picks out
  any inbound request to the gateway itself (i.e. anything that
  is run through the extension chain).
- The `myorg-hello` schema is the permission - it describes
  one specific allowed call.
- The single rule says: "when the request is addressed to the
  gateway itself, the only allowed permission is `myorg-hello`".
  Anything else - a different path, a `POST` to the same path,
  etc. - fails the rule and the gateway returns `403`.

In a real config you would normally combine this with rules for
the outbound services your agents call, e.g.:

```json
{
  "schemas": {
    "latchkey-self": { "properties": { "domain": { "const": "latchkey-self.invalid" } }, "required": ["domain"] },
    "myorg-hello":   { "properties": { "method": { "const": "GET" }, "path": { "const": "/extensions/myorg/hello" } }, "required": ["method", "path"] }
  },
  "rules": [
    { "latchkey-self":   ["myorg-hello"] },
    { "github-rest-api": ["github-read-all"] },
    { "slack-api":       ["slack-read-all"] }
  ]
}
```

Rules are evaluated top-to-bottom; the first whose scope matches
the request decides the outcome, so the extension rule and the
third-party-service rules don't interfere with each other.


## Lifecycle hooks (`start` / `stop`)

In addition to the default export, an extension module may export
optional named `start` and `stop` functions:

```js
// ~/.latchkey/extensions/notify.mjs
export default (request, response) => { /* ... */ };

export async function start() {
  // Allocate resources, open files, etc. Called once before the
  // gateway begins listening on the HTTP port.
}

export async function stop() {
  // Release resources, close long-lived responses, etc. Called once
  // at gateway shutdown, just before the HTTP server stops accepting
  // requests.
}
```

Both hooks are optional and may be either synchronous or `async`. They
are invoked sequentially across extensions in the same alphabetical
order as the handlers themselves.
