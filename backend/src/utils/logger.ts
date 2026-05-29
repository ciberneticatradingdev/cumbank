type LogData = Record<string, unknown>;

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: string, msg: string, data?: LogData): string {
  const base = `[${formatTimestamp()}] [${level}] ${msg}`;
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`;
  }
  return base;
}

export const logger = {
  info(msg: string, data?: LogData): void {
    console.log(formatMessage('INFO', msg, data));
  },

  warn(msg: string, data?: LogData): void {
    console.warn(formatMessage('WARN', msg, data));
  },

  error(msg: string, data?: LogData): void {
    console.error(formatMessage('ERROR', msg, data));
  },

  debug(msg: string, data?: LogData): void {
    console.debug(formatMessage('DEBUG', msg, data));
  },
};
