// electron-log is only used for log.error/info/warn inside handlers. No real
// Electron logging file is needed on the web — pipe to the server console.
const log = (...a) => console.log('[podvet]', ...a);
module.exports = {
  transports: { file: { level: 'info' }, console: { level: 'info' } },
  error: (...a) => console.error('[podvet]', ...a),
  warn: (...a) => console.warn('[podvet]', ...a),
  info: log,
  log: log,
};