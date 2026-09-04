const ALLOWED = new Set([
  'event', 'level', 'serviceVersion', 'protocolVersion', 'sessionId', 'utteranceId',
  'reason', 'code', 'durationMs', 'queueMs', 'inferenceMs', 'activeSessions',
  'revision', 'bytes', 'ready', 'model', 'language'
]);

export function createLogger(sink = console) {
  const write = (level, event, metadata = {}) => {
    const entry = { time: new Date().toISOString(), level, event };
    for (const [key, value] of Object.entries(metadata)) {
      if (ALLOWED.has(key) && value !== undefined) entry[key] = value;
    }
    sink[level === 'error' ? 'error' : 'log'](JSON.stringify(entry));
  };
  return {
    info: (event, metadata) => write('info', event, metadata),
    error: (event, metadata) => write('error', event, metadata)
  };
}
