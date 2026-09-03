import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import useProctoring from './useProctoring';
import * as examApi from '../lib/examApi';

vi.mock('../lib/examApi', () => ({
  saveViolation: vi.fn().mockResolvedValue(true)
}));

describe('useProctoring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('initializes with no violations', () => {
    const { result } = renderHook(() => useProctoring(true));
    expect(result.current.violations).toEqual([]);
    expect(result.current.activeViolation).toBeNull();
  });

  it('adds a violation when flag is called', () => {
    const { result } = renderHook(() => useProctoring(true));
    
    act(() => {
      result.current.flag('Test Violation');
    });

    expect(result.current.violations).toHaveLength(1);
    expect(result.current.violations[0].kind).toBe('Test Violation');
    expect(result.current.activeViolation).not.toBeNull();
    expect(result.current.activeViolation?.kind).toBe('Test Violation');
  });

  it('saves violation to DB if context is provided', () => {
    const { result } = renderHook(() => 
      useProctoring(true, 'attempt-123', 'exam-123', 'student-123')
    );
    
    act(() => {
      result.current.flag('Test Save Violation');
    });

    expect(examApi.saveViolation).toHaveBeenCalledWith(
      'attempt-123', 'exam-123', 'student-123', 'Test Save Violation', 'Test Save Violation'
    );
  });

  it('listens to blur events when active', () => {
    const { result } = renderHook(() => useProctoring(true));
    
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(result.current.violations).toHaveLength(1);
    expect(result.current.violations[0].kind).toBe('Exam window lost focus');
  });

  it('does not listen to blur events when inactive', () => {
    const { result } = renderHook(() => useProctoring(false));
    
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(result.current.violations).toHaveLength(0);
  });

  it('clears activeViolation after 5 seconds', () => {
    const { result } = renderHook(() => useProctoring(true));
    
    act(() => {
      result.current.flag('Timeout Test');
    });

    expect(result.current.activeViolation).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.activeViolation).toBeNull();
    // But it should still be in the violations list
    expect(result.current.violations).toHaveLength(1);
  });
});
