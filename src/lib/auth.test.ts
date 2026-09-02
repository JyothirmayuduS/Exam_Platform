import { describe, it, expect, vi } from 'vitest';

// Mock getSupabase to avoid actual network requests during unit tests
vi.mock('./supabase', () => {
  return {
    getSupabase: () => ({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'test-user', email: 'test@example.com' } }, error: null }),
        signInWithPassword: vi.fn().mockResolvedValue({ data: { user: { id: 'test-user' } }, error: null }),
        signOut: vi.fn().mockResolvedValue({ error: null }),
      }
    }),
    supabaseConfigured: true,
  };
});

describe('Auth Utilities', () => {
  it('should have working mocks for auth', async () => {
    const { getSupabase } = await import('./supabase');
    const supabase = getSupabase();
    
    expect(supabase).toBeDefined();
    if (!supabase) return;

    const { data } = await supabase.auth.getUser();
    expect(data?.user?.id).toBe('test-user');
    expect(data?.user?.email).toBe('test@example.com');
  });
});
