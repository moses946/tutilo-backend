// tutilo-backend/src/utils/logger.js

const formatLog = (level, message, context = {}) => {
    return JSON.stringify({
      severity: level,
      message: message instanceof Error ? message.stack : message, // Handle Error objects
      timestamp: new Date().toISOString(),
      ...context, // Attach extra data (e.g., userId, route)
    });
  };
  
  export const logger = {
    info: (message, context) => console.log(formatLog('INFO', message, context)),
    warn: (message, context) => console.warn(formatLog('WARNING', message, context)),
    error: (message, context) => console.error(formatLog('ERROR', message, context)),
    debug: (message, context) => console.debug(formatLog('DEBUG', message, context)),
  };