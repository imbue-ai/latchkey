# Latchkey (TypeScript)

A CLI tool that injects API credentials into curl requests for known third-party services.

This is a TypeScript port of the original Python latchkey project.

## Installation

```bash
npm install
npm run build
```

## Usage

### List supported services

```bash
latchkey services
```

### Run curl with credential injection

```bash
latchkey curl https://api.github.com/user
latchkey curl https://slack.com/api/auth.test
```

### Login to a service

```bash
latchkey login github
latchkey login slack
```

### Check credential status

```bash
latchkey status github
```

### Clear credentials

```bash
# Clear credentials for a specific service
latchkey clear github

# Clear all credentials and browser state
latchkey clear
```

## Environment Variables

- `LATCHKEY_STORE`: Path to JSON file for credential persistence
- `LATCHKEY_BROWSER_STATE`: Path to Playwright browser state JSON (cookies, localStorage, etc.)

## Supported Services

- **Slack** - Extracts API token and d-cookie during login
- **Discord** - Extracts authorization token from request headers
- **GitHub** - Creates a personal access token with all scopes
- **Dropbox** - Creates an app and generates an access token
- **Linear** - Creates an API key

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type check
npm run typecheck

# Watch mode
npm run dev
```

## Architecture

The project is organized into the following modules:

- `apiCredentials.ts` - Credential types (AuthorizationBearer, AuthorizationBare, SlackApiCredentials)
- `apiCredentialStore.ts` - JSON file persistence for credentials
- `browserState.ts` - Browser state path management
- `curl.ts` - Subprocess wrapper for curl execution
- `playwrightUtils.ts` - Utility for human-like typing in browser automation
- `registry.ts` - Service registry for lookup by name or URL
- `services/` - Service implementations
  - `base.ts` - Abstract base classes (Service, ServiceSession, etc.)
  - `slack.ts`, `discord.ts`, `github.ts`, `dropbox.ts`, `linear.ts` - Service implementations
- `cli.ts` - CLI entry point using Commander.js
