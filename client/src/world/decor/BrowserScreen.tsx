// A placed browser monitor in the room (#24): a slim bezel on the wall with the live browser drawn over it as a DOM
// layer that tracks the screen's position, so what plays on the wall is the real page. One screen per instance; using
// it hands over the mouse and keyboard, and returning to walking leaves it playing where it stands.
import { useState } from 'react';
import { Html } from '@react-three/drei';
import type { FloorProgressView } from '../../../../shared/progress';
import type { RepoView } from '../../../../shared/types';
import { BrowserSurface } from '../../ui/BrowserSurface';
import { decorSize } from './decor';
import { browserModel } from './models';
import { useMonitor } from './monitors';
import { vertexToon } from './parts';

// With drei's distanceFactor 1, one world unit maps to 400 CSS px, so the DOM screen matches the model exactly.
const PX_PER_UNIT = 400;

export function BrowserScreen({ repo, slot, floor }: { repo: RepoView; slot: string; floor: FloorProgressView }) {
  const id = floor.monitorSlots[slot];
  const use = useMonitor((s) => s.use);
  const close = useMonitor((s) => s.close);
  const [expanded, setExpanded] = useState(false);
  const size = decorSize('browser', slot);
  if (!id) return <mesh geometry={browserModel(size.w, size.h)} material={vertexToon} />;
  const focused = use?.id === id;
  const initial = floor.monitors[id];
  return (
    <group>
      <mesh geometry={browserModel(size.w, size.h)} material={vertexToon} />
      {/* Enlarging scales this very screen: one iframe, one player, never a duplicate audio source. */}
      <group scale={expanded ? 1.55 : 1}>
        <Html transform distanceFactor={1} position={[0, 0, 0.06]} zIndexRange={[100, 0]} pointerEvents={focused ? 'auto' : 'none'} style={{ width: Math.round(size.w * PX_PER_UNIT), height: Math.round(size.h * PX_PER_UNIT) }}>
          <BrowserSurface
            repoId={repo.id}
            id={id}
            initial={initial}
            focused={focused}
            expanded={expanded}
            onToggleExpand={() => setExpanded((e) => !e)}
            onClose={() => {
              setExpanded(false);
              close();
            }}
          />
        </Html>
      </group>
    </group>
  );
}
