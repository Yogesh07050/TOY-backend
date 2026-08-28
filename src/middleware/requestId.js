'use strict';

const crypto = require('node:crypto');

/**
 * Request correlation (§57).
 *
 * Every request gets a short reference that travels three ways: back to the
 * caller in `X-Request-Id`, into the failure log if anything goes wrong, and
 * into the error body a user can read out to support ("Reference: REQ-82917").
 *
 * The format is deliberately short and speakable rather than a UUID - it is
 * read down a phone line. Five digits give a million values, which is plenty
 * for disambiguating within the retention window of the failure log, and the
 * log's own timestamp settles any collision.
 *
 * A client-supplied `X-Request-Id` is honoured so a mobile client can correlate
 * its own crash report with the server's record. It is treated as untrusted
 * text: sanitised, length-capped, and never interpolated anywhere but a
 * placeholder.
 */

const MAX_LENGTH = 40;
const SAFE = /^[A-Za-z0-9._:-]+$/;

function generate() {
  // 0-999999, zero-padded. randomInt is uniform, unlike Math.random * range.
  return `REQ-${String(crypto.randomInt(0, 1000000)).padStart(6, '0')}`;
}

function requestId(req, res, next) {
  const supplied = req.get('X-Request-Id');
  const id =
    supplied && supplied.length <= MAX_LENGTH && SAFE.test(supplied) ? supplied : generate();

  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

module.exports = requestId;
module.exports.generate = generate;
