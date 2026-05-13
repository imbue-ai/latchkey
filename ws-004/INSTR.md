issue - latchkey doordash browser auth login seems to work the first time you do it, but the second and subsequent times, the browser stores some state and then latchkey isn't able to extract the fresh cookies.

try to reproduce and then debug until you find a fix. lookk in ../ws-001 for last time we debugged. read REPORT.md there.
