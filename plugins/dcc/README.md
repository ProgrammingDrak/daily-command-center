# DCC account assistant

Remote OAuth only. This package has no lifecycle hooks, commands, service-token
environment variables, database access, or repository access.

Deploy and verify the Clerk cutover described in docs/clerk-mcp-rollout.md before
installing this package. Author a private ChatGPT plugin using the remote URL,
OAuth and CIMD; copy the actual resulting installation URL into
DCC_CHATGPT_INSTALL_URL. No client secret or per-user callback registration is
required. Public directory listing requires separate submission/review.

Set ChatGPT's permission to **Allow read actions** to ask before changes. DCC
cannot inspect or enforce the host's setting. Bulk cleanup, imports and historical
time corrections require a separate authenticated DCC review. Installation or
connection never authorizes running coding agents, sending messages or deploying.
