// The single logging home for the monorepo. `createLogger` is the one place the
// `console` sink lives; every other package logs through a `Logger` instance so
// the backend (JSON, a transport, pino) can be swapped here without touching call
// sites. Zero workspace dependencies, so any package can depend on it cheaply.

export { type Logger, type LogLevel, type LoggerOptions, createLogger } from "./logger";
