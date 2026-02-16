import pino from "pino";

export function createLogger() {
  return pino({
    level: process.env.MARVIN_LOG_LEVEL || "info",
  });
}
