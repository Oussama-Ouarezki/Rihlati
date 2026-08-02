import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * NestJS relies on decorator metadata, which esbuild (Vitest's default
 * transformer) does not emit. SWC does, so dependency injection works in tests
 * exactly as it does at runtime.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    /**
     * One worker, no parallelism.
     *
     * Every test shares one Postgres database and truncates it between cases.
     * Run them in parallel and they delete each other's rows, which produces
     * failures that move around between runs — the most expensive kind to
     * debug. Tests here are I/O-bound anyway; the wall-clock cost is small.
     */
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
