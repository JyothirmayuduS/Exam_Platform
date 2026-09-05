import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ProctorAI from './ProctorAI';

describe('ProctorAI Component', () => {
  it('renders an invisible, painted analysis video element', () => {
    const { container } = render(
      <ProctorAI 
        cameraStream={null} 
        active={false} 
        onViolation={vi.fn()} 
        onStatus={vi.fn()} 
      />
    );

    // iOS Safari stops decoding frames for 0x0 / display:none video elements,
    // which made on-phone detection silently never start. The analysis video is
    // therefore transparent (opacity-0) but still laid out at a real size.
    const video = container.querySelector('video') as HTMLVideoElement;
    const wrapper = container.querySelector('.fixed') as HTMLElement;
    expect(video).toBeInTheDocument();
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toContain('opacity-0');
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
  });
});
