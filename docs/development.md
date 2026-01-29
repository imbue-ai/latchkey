# Developing Latchkey

Thank you for considering contributing to Latchkey!

## Setting up your environment

The easiest way to set up your system so that you can run
Latchkey while working on it is to clone this repository and
then run:

```
npm install && playwright install chromium && npm run build && npm link
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


_Can an API token be extracted from the network traffic that flows between the browser and the service's website during or after login?_

If the answer is yes, see how the Discord service is implemented and try to do it similarly.

Otherwise, ask yourself the following question:

_Can an API token be created in the user's account (e.g. in Developer settings)?_

If so, see how the Linear service is implemented and try to do it similarly.

When possible, the first option (extracting the token from the network traffic) is always preferable because it's simpler, more robust, and less invasive.
If the answer is no in both cases, it's a special case and you're on your own!


### Potentially useful helpers

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


#### Browser automation recorder

When automating the browser login follow-up, you can sometimes
use Playwright's codegen functionality, for example:

```
npx playwright codegen --target=javascript https://login-page.example.com/
```
