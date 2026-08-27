# Developing Latchkey

Thank you for considering contributing to Latchkey!

## Setting up your environment

Make sure you're using [nvm](https://github.com/nvm-sh/nvm) so that your node version
corresponds to the one listed in `.nvmrc`.

After that, the easiest way to set up your system so that you can run
Latchkey while working on it is to clone this repository and
then run:

```bash
npm install && npm run build && npm link
```

After that, every time you make a change to the code, run
`npm run build`. Invoking `latchkey` in your terminal will
then use the version you just built. (`npm run dev` runs the
compiler in watch mode if you would rather not rebuild by hand.)

## Before you submit a PR

- Run `npm run lint` and `npm test` to validate your changes.
- Run `npm run format` to apply autoformatting.


## Adding a new service

Services in Latchkey come in two tiers:

- With basic support that requires users to directly set
API credentials via `latchkey auth set` or `latchkey auth
set-nocurl`.
- With support for browser-based authentication.

### Basic support

If you only want to make Latchkey aware of the existence of
a particular service, you just need to implement a Service class
with a few attributes (like a name, base API URL(s) and a few
others). As an example, see the [Mailchimp](../src/services/mailchimp.ts)
service.


### Support for browser-based authentication

In this case, you will typically need to add several additional
methods to the implementation from the previous section.

Each third-party service needs to be approached slightly
differently. You need to start by asking yourself the following
question:


_Can public API credentials be extracted from the network traffic that flows between the browser and the service's website during or after login?_

If the answer is yes, see how the [Slack](../src/services/slack.ts) service is implemented and try to do it similarly.

Otherwise, ask yourself the following question:

_Can an API token be created in the user's account (e.g. in Developer settings)?_

If so, see how the [Linear](../src/services/linear.ts) service is implemented and try to do it similarly.

If the answer is no in both cases, it's a special case and you're on your own!

Above, when we say "API", we always mean a public API. Do
not expose undocumented private APIs through Latchkey - agents
should be able to determine usage by consulting the documentation.

### When the automation breaks

Browser automation eventually breaks (a redesign, a new consent
step), usually by timing out. When that happens, the browser is
signed in and sitting on the right page, so the login is usually
still doable by hand — and a session can offer the user that way
out by defining `manualCredentialForm` (see
[GitHub](../src/services/github.ts)): the fields the user can
paste back (typically one API key, sometimes a client id and
secret) plus a `buildCredentials(values)` step.

For such sessions, a failure no longer closes the browser. The
spinner is replaced by a notice saying what failed, what to do
about it (`manualCompletionInstructions`, e.g. "open this URL,
name the token, tick these scopes") and the form itself. What the
user submits is checked with the service's own
`checkApiCredentials` before being accepted, and rejected values
are reported back into the form so they can be corrected on the
spot.

Asking is deliberate: reading the credentials off the page would
be guesswork about a service that has just proven it changed,
while a form keeps working however the pages look.

The wait ends when usable credentials are submitted, when the
user closes the browser window, or after a fixed limit (15
minutes). Unless credentials arrived, the original automation
failure is the error that gets reported.

Sessions without a form keep the old behaviour: the failure is
reported immediately and the browser closes, since there is
nowhere to put credentials the user might produce.

### Service info

Every service must include an `info` property that provides developer notes. This information is accessible via `latchkey services info <service_name>` and helps agents and users understand service-specific details such as:

- Links to API documentation
- Special requirements (e.g., need to run `latchkey auth browser-prepare` first)
- Any caveats or limitations

Keep `info` (and comments on the `Service` class) about the service itself, not
the Detent scopes or permission names (not everyone uses them).

### Potentially useful helpers

#### Codegen

Use this tool to record a full session where you log into a service and generate an API key:

```bash
npx tsx scripts/codegen.ts <service_name> <initial_url>
```

This tool combines both the request/response recorder (see below) and Playwright's own codegen functionality.

You can still use Playwright's own codegen if this tool is not sufficient:

```bash
npx playwright codegen --target=javascript https://login-page.example.com/
```

#### Request / response recorder

Use this to record the request/response pairs of your browser
login sequence as plaintext JSON files. The resulting recording
can be inspected, either manually or with the help of AI, to see
if you can extract an API token or something similar from there.

```bash
npx tsx scripts/recordBrowserSession.ts <service_name>
```

If you have `jq` installed on your system, you can then
start exploring, for instance like this:

```bash
cat path/to/recording/login_session.json | jq -C | less -R
```

#### File encryptor / decryptor

During development, it may sometimes be necessary to inspect the
credentials stored in `~/.latchkey/credentials.json.enc`.

To do that, you can use `scripts/cryptFile.ts`. For example:

```bash
npx tsx scripts/cryptFile.ts decrypt ~/.latchkey/credentials.json.enc
```



## Environment variables

The following environment variables can be set for development and debugging:

- `LATCHKEY_DISABLE_SPINNER=1`: Disables the spinner overlay that normally hides browser activity during credential finalization. Useful for debugging browser automation sequences.


## Style guidelines

- Try to make new code look as similar to existing code as possible.
- See CLAUDE.md for additional details.
