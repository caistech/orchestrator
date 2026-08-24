import path from 'node:path';
import { defineConfig } from 'vitest/config';

// The `@/` alias mirrors tsconfig paths, so route files (which import via `@/lib/…`) can be tested
// directly rather than only the alias-free modules under src/. Without it, every route-level test
// fails at import resolution and the auth shell of a route goes unasserted — the part that decides
// who may call it at all.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  test: {
    environment: 'node',
  },
});
