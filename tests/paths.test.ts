import { describe, expect, it } from 'vitest';
import { getDefaultDataDirectory, getDefaultDatabasePath } from '@career-compiler/storage';

describe('storage paths', () => {
  it('keeps the database in an OS-level user data directory', () => {
    const env = { APPDATA: 'C:/Users/test/AppData/Roaming' };
    expect(getDefaultDataDirectory(env)).toContain('career-compiler');
    expect(getDefaultDatabasePath(env)).toMatch(/career-compiler[\\/]career-compiler\.sqlite$/);
  });
});
