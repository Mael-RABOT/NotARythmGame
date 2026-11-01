import React, { Suspense, lazy, useEffect, useState } from 'react';
import { useSettings } from './storage/settings';
import { DecodeText, GridBackground } from './ui/components/decor';
import { Toasts, toast } from './ui/components/overlays';
import { CalibrationScreen } from './ui/screens/CalibrationScreen';
import { PlayScreen } from './ui/screens/play/PlayScreen';
import { ResultsScreen } from './ui/screens/ResultsScreen';
import { SettingsScreen } from './ui/screens/SettingsScreen';
import { SongSelectScreen } from './ui/screens/SongSelectScreen';
import { TitleScreen } from './ui/screens/TitleScreen';
import { go, useApp } from './ui/store/app';
import { importNargFile, useLibrary } from './ui/store/library';

// the editor is its own chunk: the game shell stays small
const EditorScreen = lazy(() => import('./ui/editor/EditorScreen'));

const AUDIO_EXT = /\.(mp3|ogg|oga|wav|flac|m4a|aac|opus|webm)$/i;

const Loading: React.FC = () => (
  <div className="screen" style={{ placeItems: 'center', display: 'grid' }}>
    <span className="section-label"><DecodeText text="LOADING EDITOR" delay={0} /></span>
  </div>
);

export const App: React.FC = () => {
  const screen = useApp((s) => s.screen);
  const theme = useSettings((s) => s.theme);
  const motion = useSettings((s) => s.reducedMotion);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    void useLibrary.getState().refresh();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0E0E0F' : '#F7F1E5');
  }, [theme]);

  useEffect(() => {
    const el = document.documentElement;
    if (motion === 'system') delete el.dataset.motion;
    else el.dataset.motion = motion === 'on' ? 'reduce' : 'full';
  }, [motion]);

  // global drag & drop: .narg imports, audio opens the editor (the editor handles its own drops)
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (useApp.getState().screen.name === 'editor' || useApp.getState().screen.name === 'play') return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      for (const f of files) {
        if (/\.narg$/i.test(f.name)) {
          try {
            const chart = await importNargFile(f);
            toast(`Imported “${chart.meta.title}”`, 'success');
            go({ name: 'select', focusSongId: chart.id });
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        } else if (AUDIO_EXT.test(f.name) || f.type.startsWith('audio/')) {
          go({ name: 'editor', newFile: f });
          return;
        } else {
          toast(`Can't open ${f.name}: drop a .narg chart or an audio file`, 'error');
        }
      }
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  let content: React.ReactNode;
  switch (screen.name) {
    case 'title': content = <TitleScreen />; break;
    case 'select': content = <SongSelectScreen focusSongId={screen.focusSongId} />; break;
    case 'play': content = <PlayScreen request={screen.request} />; break;
    case 'results': content = <ResultsScreen result={screen.result} />; break;
    case 'settings': content = <SettingsScreen back={screen.back} tab={screen.tab} />; break;
    case 'calibration': content = <CalibrationScreen back={screen.back} />; break;
    case 'editor':
      content = (
        <Suspense fallback={<Loading />}>
          <EditorScreen songId={screen.songId} newFile={screen.newFile} resume={screen.resume} />
        </Suspense>
      );
      break;
  }

  const showDrop = dragging && screen.name !== 'editor' && screen.name !== 'play';
  return (
    <>
      <GridBackground dim={screen.name === 'play' || screen.name === 'editor'} />
      {content}
      {showDrop && (
        <div className="dropzone">
          <div className="dropzone__inner">
            <span className="eyebrow">Drop to open</span>
            <h2>.narg chart → library · audio → new chart</h2>
          </div>
        </div>
      )}
      <Toasts />
    </>
  );
};
