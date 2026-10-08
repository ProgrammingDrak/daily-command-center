// Same app assets and handlers, backed only by the in-memory review server.
process.env.DCC_REVIEW_TASK_DETAILS='1';
process.env.PORT=process.env.PORT||'8301';
await import('./ui-review-server.mjs');
