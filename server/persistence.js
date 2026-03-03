'use strict';

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'balances.json');
const DEFAULT_BALANCE = 1000;

function _load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function getBalance(pseudo) {
  const data = _load();
  return data[pseudo] ?? DEFAULT_BALANCE;
}

function setBalance(pseudo, amount) {
  const data = _load();
  data[pseudo] = amount;
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

module.exports = { getBalance, setBalance };
