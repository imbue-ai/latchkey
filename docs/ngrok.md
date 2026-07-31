# ngrok

Latchkey supports [ngrok](https://ngrok.com) as a built-in service. The stored
credential is an ngrok **API key**, which authenticates requests to the ngrok
REST API at `https://api.ngrok.com`.

## Authentication

Every ngrok API request needs two headers: the bearer API key and a constant
`ngrok-version` header (see the [ngrok API docs](https://ngrok.com/docs/api/#authentication)).
Latchkey stores both, so a plain `latchkey curl` works without you supplying the
version header:

```bash
latchkey curl https://api.ngrok.com/api_keys
# -> 200, injected with:
#      Authorization: Bearer <api-key>
#      ngrok-version: 2
```

### Getting a key

`latchkey auth browser ngrok` opens the ngrok dashboard, has you sign in, then
creates a fresh API key on your account and stores it. You can also set one
manually:

```bash
latchkey auth set ngrok -H "Authorization: Bearer <token>" -H "ngrok-version: 2"
```

## Running tunnels (the API key is not the agent authtoken)

The credential above is an **API key** for the REST API. The `ngrok` agent (CLI,
SDK, Kubernetes Operator) authenticates tunnels with a different credential, an
**authtoken**. The two are not interchangeable: the API key will not start a
tunnel, and an authtoken will not call the REST API.

An authtoken is itself a REST resource (`/credentials`), so you mint one on
demand with the stored API key and feed it to the agent. The new authtoken is
returned in the response body:

```bash
# 1. Mint a tunnel authtoken (authenticated by the stored API key).
authtoken=$(latchkey curl -s -X POST https://api.ngrok.com/credentials \
  -H "Content-Type: application/json" \
  -d '{"description":"my-tunnel"}' | jq -r .token)

# 2. Hand it to the ngrok agent and open a tunnel.
ngrok config add-authtoken "$authtoken"
ngrok http 8080
```

This keeps the durable secret (the API key) in latchkey while the agent
authtoken is minted as needed. Delete an authtoken you are done with via
`DELETE /credentials/<id>` (list them with `GET /credentials`).
