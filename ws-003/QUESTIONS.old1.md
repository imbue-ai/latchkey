# CycleTLS Integration Questions

1. Should CycleTLS be an optional dependency (lazy-loaded)? Would avoid bloating installs for users who don't need it.

yes optional

2. Should the JA3 fingerprint be configurable per-service, or hardcoded to Chrome?
just do chrome, latchkey is bound to chromium anyways

3. Does `latchkey curl` for DoorDash need full interactive stdio support, or is captured output sufficient?
not sure, we'll figure out as we test
