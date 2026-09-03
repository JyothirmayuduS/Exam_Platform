import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import useExamTimer from './useExamTimer';

describe('useExamTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('initializes correctly with given minutes', () => {
    const { result } = renderHook(() => 
      useExamTimer({ durationMinutes: 10, active: false, onTimeUp: vi.fn() })
    );

    expect(result.current.secondsLeft).toBe(600);
    expect(result.current.timeString).toBe('10:00');
    expect(result.current.tone).toBe('text-success border-success');
    expect(result.current.warning).toBeNull();
  });

  it('counts down when active', () => {
    const { result } = renderHook(() => 
      useExamTimer({ durationMinutes: 10, active: true, onTimeUp: vi.fn() })
    );

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.secondsLeft).toBe(599);
    expect(result.current.timeString).toBe('09:59');
  });

  it('calls onTimeUp when reaching 0', () => {
    const onTimeUp = vi.fn();
    renderHook(() => 
      useExamTimer({ durationMinutes: 1, active: true, onTimeUp })
    );

    for (let i = 0; i < 60; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }

    expect(onTimeUp).toHaveBeenCalledTimes(1);
  });

  it('provides correct warnings based on time left', () => {
    const { result } = renderHook(() => 
      useExamTimer({ durationMinutes: 5, active: true, onTimeUp: vi.fn() })
    );
    
    // At 5 mins
    expect(result.current.warning).toBe('5 minutes remaining');
    expect(result.current.tone).toBe('text-amber border-amber');

    for (let i = 0; i < 4 * 60; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }

    // At 1 min
    expect(result.current.secondsLeft).toBe(60);
    expect(result.current.warning).toBe('1 minute remaining');
    expect(result.current.tone).toBe('text-alert border-alert');
  });
});
