# Plugins

Support for additional services in Latchkey can be provided via plugins.


## Installation

To install a plugin, simply clone it to the `~/.latchkey/plugins` directory:

```bash
git clone https://github.com/imbue-ai/latchkey-spotify ~/.latchkey/plugins/spotify
```

Before you do this, make sure you trust the plugin author,
because the plugin will have access to your credentials.


## Uninstallation

To uninstall, just delete the plugin directory:

```bash
rm -rf ~/.latchkey/plugins/spotify
```


## Known plugins

- https://github.com/imbue-ai/latchkey-spotify

If you create a plugin, let us know!


## Writing a plugin

A plugin is an ES module package. Its default export is a factory that
receives the Latchkey SDK and returns the plugin's manifest. Here's an example from
the [latchkey-spotify](https://github.com/imbue-ai/latchkey-spotify) plugin:

```typescript
import type { LatchkeyPlugin, LatchkeySdk } from 'latchkey/plugin';
import { createSpotify } from './spotify.js';

export default function plugin(sdk: LatchkeySdk): LatchkeyPlugin {
  const { Spotify, SpotifySessionCredentials } = createSpotify(sdk);
  return {
    latchkeyVersion: '^3.15.0',
    services: [new Spotify()],
    apiCredentialsTypes: [SpotifySessionCredentials],
  };
}
```

As you can see, a plugin declares:

- The Latchkey versions it's compatible with (using semver notation).
- The services it implements.
- New credential classes it implements, if any.


A plugin can't have dependencies of its own, because Latchkey
doesn't install them. Everything it needs at runtime comes from
the `sdk` object. This also means that plugins written in
TypeScript have to contain the compiled output (`dist`) in
their repository.


### Why write a plugin?

Latchkey has a policy that for a service to be part of the
built-in set, its implementation has to talk to a documented,
public API. Plugins are a mechanism to support undocumented
APIs (at the user's own risk).

There are other potential reasons, too. For example, writing
a plugin for your own use may be faster than filing a pull
request and waiting for a new Latchkey release.


### More resources

- As a starting point, see the [example plugin](https://github.com/imbue-ai/latchkey-spotify).
- The [development docs](development.md#adding-a-new-service) have some further hints on implementing support for a new service.
