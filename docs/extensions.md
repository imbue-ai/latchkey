# Gateway extensions

You can extend the gateway with your own HTTP endpoints.
At startup, `latchkey gateway` scans `~/.latchkey/extensions/` (or the corresponding alternative if you override `LATCHKEY_DIRECTORY`) for
files ending in `.mjs` (in alphabetical order) and dynamically
imports each one. Every module's default export must be a
function with the signature
`(request, response) => boolean | Promise<boolean>`:

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
