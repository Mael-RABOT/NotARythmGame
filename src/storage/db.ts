import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Chart } from '../core/chart/types';

/**
 * IndexedDB layout:
 *  songs:     one record per song (chart JSON + audio bytes)
 *  bests:     personal best per `${songId}:${difficultyId}`
 *  autosave:  editor session snapshots (crash-safe restore)
 */
export interface SongRecord {
  id: string;
  chart: Chart;
  audioName: string;
  audio: ArrayBuffer;
  cover?: ArrayBuffer;
  updatedAt: number;
  createdAt: number;
}

export interface BestRecord {
  key: string;
  score: number;
  accuracy: number;
  maxCombo: number;
  grade: string;
  fullCombo: boolean;
  cleared: boolean;
  plays: number;
  at: number;
}

export interface AutosaveRecord {
  id: string;           // song id
  chart: Chart;
  audioName: string;
  audio: ArrayBuffer;
  at: number;
}

interface NargDB extends DBSchema {
  songs: { key: string; value: SongRecord };
  bests: { key: string; value: BestRecord };
  autosave: { key: string; value: AutosaveRecord };
}

let dbPromise: Promise<IDBPDatabase<NargDB>> | null = null;
const db = () => {
  if (!dbPromise) {
    dbPromise = openDB<NargDB>('not-a-rythm-game', 1, {
      upgrade(d) {
        d.createObjectStore('songs', { keyPath: 'id' });
        d.createObjectStore('bests', { keyPath: 'key' });
        d.createObjectStore('autosave', { keyPath: 'id' });
      },
    });
  }
  return dbPromise;
};

export const songsDb = {
  async all(): Promise<SongRecord[]> {
    return (await db()).getAll('songs');
  },
  async get(id: string): Promise<SongRecord | undefined> {
    return (await db()).get('songs', id);
  },
  async put(rec: SongRecord): Promise<void> {
    await (await db()).put('songs', rec);
  },
  async remove(id: string): Promise<void> {
    await (await db()).delete('songs', id);
  },
};

export const bestsDb = {
  key: (songId: string, diffId: string) => `${songId}:${diffId}`,
  async all(): Promise<BestRecord[]> {
    return (await db()).getAll('bests');
  },
  async get(songId: string, diffId: string): Promise<BestRecord | undefined> {
    return (await db()).get('bests', bestsDb.key(songId, diffId));
  },
  /** Stores the run if it beats the previous best. Returns true on a new best. */
  async submit(songId: string, diffId: string, run: Omit<BestRecord, 'key' | 'plays' | 'at'>): Promise<boolean> {
    const d = await db();
    const key = bestsDb.key(songId, diffId);
    const prev = await d.get('bests', key);
    const better = !prev || run.score > prev.score;
    const isBest = run.score > 0 && better;
    const rec: BestRecord = better || !prev
      ? { ...run, key, plays: (prev?.plays ?? 0) + 1, at: Date.now(), fullCombo: run.fullCombo || !!prev?.fullCombo, cleared: run.cleared || !!prev?.cleared }
      : { ...prev, plays: prev.plays + 1, fullCombo: prev.fullCombo || run.fullCombo, cleared: prev.cleared || run.cleared };
    await d.put('bests', rec);
    return isBest;
  },
};

export const autosaveDb = {
  async get(id: string): Promise<AutosaveRecord | undefined> {
    return (await db()).get('autosave', id);
  },
  async latest(): Promise<AutosaveRecord | undefined> {
    const all = await (await db()).getAll('autosave');
    return all.sort((a, b) => b.at - a.at)[0];
  },
  async put(rec: AutosaveRecord): Promise<void> {
    await (await db()).put('autosave', rec);
  },
  async remove(id: string): Promise<void> {
    await (await db()).delete('autosave', id);
  },
};
