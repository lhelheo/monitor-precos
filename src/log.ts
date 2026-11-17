import { config } from './config.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[config.logLevel] ?? 20;

function out(level, args) {
  if (LEVELS[level] < min) return;
  const ts = new Date().toISOString();
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`${ts} ${level.toUpperCase().padEnd(5)}`, ...args);
}

export const log = {
  debug: (...a) => out('debug', a),
  info: (...a) => out('info', a),
  warn: (...a) => out('warn', a),
  error: (...a) => out('error', a),
};
