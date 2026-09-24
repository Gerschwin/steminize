import type { Settings } from '../settings.ts';

export const extensionFor = (o: Pick<Settings, 'format'>) => o.format;
export const mimeFor = (o: Pick<Settings, 'format'>) =>
  o.format === 'wav' ? 'audio/wav' : o.format === 'flac' ? 'audio/flac' : 'audio/mpeg';
