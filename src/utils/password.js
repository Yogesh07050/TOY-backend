'use strict';

const bcrypt = require('bcryptjs');
const env = require('../config/env');

const hash = (plain) => bcrypt.hash(plain, env.bcryptRounds);
const compare = (plain, passwordHash) => bcrypt.compare(plain, passwordHash);

/**
 * Password policy (§19): at least 8 characters with an upper case letter, a
 * lower case letter and a digit. Returns a list of human readable problems.
 */
function validateStrength(password) {
  const problems = [];
  if (typeof password !== 'string' || password.length < 8) {
    problems.push('Password must be at least 8 characters long');
  }
  if (!/[a-z]/.test(password || '')) problems.push('Password must contain a lowercase letter');
  if (!/[A-Z]/.test(password || '')) problems.push('Password must contain an uppercase letter');
  if (!/\d/.test(password || '')) problems.push('Password must contain a number');
  return problems;
}

module.exports = { hash, compare, validateStrength };
