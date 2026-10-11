import { describe, expect, it } from 'vitest';
import { monitorAddress, parseMonitor, youtubeEmbedUrl, youtubeErrorText, youtubeId, YOUTUBE_ERRORS } from './monitor';

describe('parseMonitor', () => {
  it('treats empty input as the home surface', () => {
    expect(parseMonitor('')).toEqual({ kind: 'home' });
    expect(parseMonitor('   ')).toEqual({ kind: 'home' });
  });

  it('accepts an ordinary https page, with or without a scheme', () => {
    expect(parseMonitor('https://example.com/a?b=1')).toEqual({ kind: 'page', url: 'https://example.com/a?b=1' });
    expect(parseMonitor('example.com')).toEqual({ kind: 'page', url: 'https://example.com/' });
  });

  it('rejects unsupported schemes', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'mailto:a@b.com']) {
      expect(parseMonitor(bad).kind).toBe('invalid');
    }
  });

  it('reads watch, youtu.be, embed and shorts links as videos', () => {
    expect(parseMonitor('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toMatchObject({ kind: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseMonitor('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({ kind: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseMonitor('https://www.youtube.com/embed/dQw4w9WgXcQ')).toMatchObject({ kind: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseMonitor('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toMatchObject({ kind: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseMonitor('https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s')).toMatchObject({ kind: 'youtube', id: 'dQw4w9WgXcQ' });
  });

  it('treats the YouTube homepage as a page, not a video', () => {
    expect(parseMonitor('https://www.youtube.com')).toMatchObject({ kind: 'page' });
    expect(parseMonitor('https://www.youtube.com/watch?v=short')).toMatchObject({ kind: 'page' });
  });

  it('reads the id from a URL the same way', () => {
    expect(youtubeId(new URL('https://youtu.be/dQw4w9WgXcQ'))).toBe('dQw4w9WgXcQ');
    expect(youtubeId(new URL('https://example.com/watch?v=dQw4w9WgXcQ'))).toBeNull();
  });
});

describe('youtubeEmbedUrl', () => {
  it('asks for the API and carries our origin', () => {
    const url = youtubeEmbedUrl('dQw4w9WgXcQ', 'http://localhost:4399');
    expect(url).toContain('/embed/dQw4w9WgXcQ');
    expect(url).toContain('enablejsapi=1');
    expect(url).toContain('origin=http%3A%2F%2Flocalhost%3A4399');
  });
});

describe('youtube errors', () => {
  it('explains the common codes and error 153', () => {
    expect(youtubeErrorText(153)).toBe(YOUTUBE_ERRORS[153]);
    expect(youtubeErrorText(153)).toMatch(/origin|referrer/i);
    expect(youtubeErrorText(100)).toMatch(/private|removed/i);
    expect(youtubeErrorText(999)).toMatch(/999/);
  });
});

describe('monitorAddress', () => {
  it('shows the address we were given, truthfully', () => {
    expect(monitorAddress('https://example.com/x')).toBe('https://example.com/x');
    expect(monitorAddress('')).toBe('');
  });
});
