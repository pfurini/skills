import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Redirect HOME to a throwaway dir so tests never read or clobber the real
    // global skill lock (~/.agents/.skill-lock.json). See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
  },
});
