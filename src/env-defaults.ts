/**
 * Imported first by every entry point. `@contextvm/sdk` configures its pino
 * logger from the environment at import time, so anything we want it to
 * default to has to be in place before that import runs.
 *
 * The SDK logs every relay connection and announcement at `info` as JSON on
 * stderr; that is noise next to our own log, so it defaults to `warn` —
 * relay errors and rejected messages still show. Set `LOG_LEVEL` to override.
 */
process.env.LOG_LEVEL ??= 'warn'
