'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * Ambient request context (§4, §12).
 *
 * §4 requires the correlation id to appear in "database-related logs where
 * useful", and §12 lists Request ID as the first thing a database failure must
 * record. The database layer, though, is four or five calls below the request:
 * `pool.query` has no idea who asked. The alternatives are to thread a context
 * argument through every service and repository signature in the codebase - a
 * change to hundreds of call sites that one forgotten parameter silently
 * defeats - or to carry it out of band.
 *
 * `AsyncLocalStorage` is Node's own mechanism for exactly this. A value stored
 * when the request begins stays readable from anything that runs during it,
 * across `await`s and callbacks, without being passed anywhere.
 *
 * Reads are always optional. Code runs outside any request all the time - at
 * boot, in a cron job, in a test - and `current()` returning null there is the
 * normal case, not an error. Nothing may depend on the context existing; it
 * enriches a log line and never changes behaviour.
 */

const storage = new AsyncLocalStorage();

/** Runs `fn` with `context` readable from everything it invokes. */
const run = (context, fn) => storage.run(context, fn);

/** The current context, or null outside a request or job. */
const current = () => storage.getStore() ?? null;

/** The correlation id to attach to a log line, or undefined if there is none. */
const currentId = () => storage.getStore()?.requestId;

module.exports = { run, current, currentId, storage };
