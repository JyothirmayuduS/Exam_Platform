import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ProctorAI from './ProctorAI';

describe('ProctorAI Component', () => {
  it('renders a hidden video element', () => {
    const { container } = render(
      <ProctorAI 
        cameraStream={null} 
        active={false} 
        onViolation={vi.fn()} 
        onStatus={vi.fn()} 
      />
    );

    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video).toBeInTheDocument();
    expect(video.className).toContain('sr-only');
    expect(video.className).toContain('pointer-events-none');
    expect(video.muted).toBe(true);
  });
});
