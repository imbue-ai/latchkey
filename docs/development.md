# Developing Latchkey

Thank you for considering contributing to Latchkey!

## Setting up your environment

Make sure you're using [nvm](https://github.com/nvm-sh/nvm) so that your node version
corresponds to the one listed in `.nvmrc`.

After that, the easiest way to set up your system so that you can run
Latchkey while working on it is to clone this repository and
then run:

```
npm install && npm run build && npm link
```

After that, every time you make a change to the code, run
`npm run rebuild`. Invoking `latchkey` in your terminal will
then use the version you just built.

## Before you submit a PR

- Run `npm lint` and `npm test` to validate your changes.
- Run `npm format` to apply autoformatting.


## Adding a new service

Each third-party service needs to be approached slightly
differently. When adding support for a new service, you need to
start by asking yourself the following question:


_Can public API credentials be extracted from the network traffic that flows between the browser and the service's website during or after login?_

If the answer is yes, see how the [Slack](../src/services/slack.ts) service is implemented and try to do it similarly.

Otherwise, ask yourself the following question:

_Can an API token be created in the user's account (e.g. in Developer settings)?_

If so, see how the [Linear](../src/services/linear.ts) service is implemented and try to do it similarly.

If the answer is no in both cases, it's a special case and you're on your own!

Above, when we say "API", we always mean a public API. Do
not expose undocumented private APIs through Latchkey - agents
should be able to determine usage by consulting the documentation.

### Service info

Every service must include an `info` property that provides developer notes. This information is accessible via `latchkey info <service_name>` and helps agents and users understand service-specific details such as:

- Links to API documentation
- Special requirements (e.g., need to run `latchkey prepare` first)
- Any caveats or limitations

### Potentially useful helpers

#### Codegen

Use this tool to record a full session where you log into a service and generate an API key:

```
npx tsx scripts/codegen.ts <service_name> <initial_url>
```

This tool combines both the request/response recorder (see below) and Playwright's own codegen functionality.

You can still use Playwright's own codegen if this tool is not sufficient:

```
npx playwright codegen --target=javascript https://login-page.example.com/
```

#### Request / response recorder

Use this to record the request/response pairs of your browser
login sequence as plaintext JSON files. The resulting recording
can be inspected, either manually or with the help of AI, to see
if you can extract an API token or something similar from there.

```
npx tsx scripts/recordBrowserSession.ts <service_name>
```

If you have `jq` installed on your system, you can then
start exploring, for instance like this:

```
cat path/to/recording/login_session.json | jq -C | less -R
```

#### File encryptor / decryptor

During development, it may sometimes be necessary to inspect the
credentials stored in `~/.latchkey/credentials.json.enc`.

To do that, you can use `scripts/cryptFile.ts`. For example:

```
npx tsx scripts/cryptFile.ts decrypt ~/.latchkey/credentials.json.enc
```



## Environment variables

The following environment variables can be set for development and debugging:

- `LATCHKEY_DISABLE_SPINNER=1`: Disables the spinner overlay that normally hides browser activity during credential finalization. Useful for debugging browser automation sequences.


## Style guidelines

- Try to make new code look as similar to existing code as possible.
- See CLAUDE.md for additional details.
