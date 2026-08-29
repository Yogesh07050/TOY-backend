'use strict';

const crypto = require('node:crypto');
const logger = require('../utils/logger');
const { internalCodeFor, categoryFor } = require('../config/errorCodes');

/**
 * Background job instrumentation (§24).
 *
 * A cron run has no request and therefore no `REQ-` reference, which makes it
 * the one part of the system §4's correlation story does not reach. §24's
 * answer is to give each run its own id - `JOB-EXPIRY-8271` - and that id plays
 * exactly the role a request id does: every line one run produces carries it,
 * so a run is reconstructed by filtering on a single value.
 *
 * ## Why a wrapper rather than logging inside each job
 *
 * §24 asks every job for the same six facts: started, records found, processed,
 * failed, completed, duration. Left to each job, that becomes eight
 * hand-formatted `console.log` calls that agree on nothing - and the two facts
 * that matter most, duration and failure, are the two most likely to be
 * forgotten. Here a job returns counts and the wrapper does the rest, so a new
 * job is instrumented correctly by default rather than by diligence.
 *
 * A job that returns nothing is fine; it simply reports no counts. A job that
 * throws is caught, logged at ERROR with its duration, and does not take the
 * scheduler down with it.
 */

/**
 * `JOB-PRUNE-8271`. The suffix distinguishes runs of the same job, which is the
 * whole point - "the expiry job is slow" is a different question from "the
 * 09:00 run was slow", and without it the two cannot be told apart.
 */
const jobId = (name) => `JOB-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}-${crypto.randomInt(1000, 10000)}`;

/**
 * Runs one job with §24's lifecycle logging.
 *
 * The job receives its own logger, so anything it wants to say mid-run is
 * correlated with the run automatically. It may return
 * `{ found, processed, failed, ...detail }`; every field is optional and any
 * extra keys are logged as-is, which is how a job with several counters
 * (`activated`/`expired`) reports them without inventing a format.
 */
async function runJob(job) {
  const id = jobId(job.name);
  const log = logger.forJob(id, job.name);
  const startedAt = process.hrtime.bigint();

  log.info({ event: 'JOB_STARTED' }, `${job.name} started`);

  try {
    const result = (await job.run(log)) ?? {};
    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
    const { found, processed, failed, ...detail } = result;

    log.info(
      {
        event: 'JOB_COMPLETED',
        duration_ms: durationMs,
        // Reported only when the job counted them. A zero and an "it does not
        // count this" are different facts, and collapsing them makes a
        // dashboard of "records processed" quietly wrong.
        ...(found === undefined ? {} : { records_found: found }),
        ...(processed === undefined ? {} : { records_processed: processed }),
        ...(failed === undefined ? {} : { records_failed: failed }),
        ...detail,
      },
      `${job.name} completed in ${durationMs}ms`,
    );
    return result;
  } catch (error) {
    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
    const errorCode = internalCodeFor(error, 'INTERNAL_SERVER_ERROR');

    log.error(
      {
        event: 'JOB_FAILED',
        duration_ms: durationMs,
        error_code: errorCode,
        category: categoryFor(errorCode),
        err_message: error.message,
        stack: error.stack,
      },
      `${job.name} failed after ${durationMs}ms`,
    );
    // Swallowed on purpose: node-cron has no error channel, and an unhandled
    // rejection here would take down a process that is otherwise serving
    // traffic perfectly well. The ERROR line above is the alarm (§29).
    return null;
  }
}

module.exports = { runJob, jobId };
