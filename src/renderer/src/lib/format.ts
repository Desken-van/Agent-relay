import type { RunEvent } from '@shared/domain/models';

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatDuration(startedAt: string, finishedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return '—';

  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface DecodedEvent {
  readonly text: string;
  readonly data: Record<string, unknown> | null;
}

/** Run event payloads are JSON strings; decode defensively. */
export function decodeEvent(event: RunEvent): DecodedEvent {
  try {
    const parsed = JSON.parse(event.payload) as { text?: unknown; data?: unknown };
    return {
      text: typeof parsed.text === 'string' ? parsed.text : event.payload,
      data:
        typeof parsed.data === 'object' && parsed.data !== null
          ? (parsed.data as Record<string, unknown>)
          : null
    };
  } catch {
    return { text: event.payload, data: null };
  }
}

export function truncateMiddle(text: string, max = 64): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
