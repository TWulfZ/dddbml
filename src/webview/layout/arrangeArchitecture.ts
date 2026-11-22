import type { AutoArrangeMode } from '../../shared/types';
import { schedulePersist } from '../persistence';
import { buildMoveCommand } from '../state/history';
import { isCanvasReadOnly, store } from '../state/store';
import { buildArchitectureScene, defaultArchitecturePositions, type Point } from './architectureLayout';
import { diagramAnnotations } from './diagramLabels';

export function arrangeArchitecture(mode: AutoArrangeMode = 'all'): void {
  const state = store.getState();
  const { architecture } = state.schema;
  if (!architecture || isCanvasReadOnly(state)) return;
  const { notes } = diagramAnnotations(state.schema, state.labelLayouts);
  const scene = buildArchitectureScene(architecture, state.positions, notes);
  const selected = new Set(state.selection);
  if (mode === 'selection') {
    if (!selected.size) { state.showNotice('Select architecture elements first'); return; }
    for (const group of scene.groups) {
      if (selected.has(group.id)) for (const key of group.movable) selected.add(key);
    }
  }
  const from = new Map<string, Point>(scene.nodes.map(({ id, x, y }) => [id, { x, y }]));
  for (const group of scene.groups) if (!group.children.length) from.set(group.id, { x: group.x, y: group.y });
  for (const note of scene.notes) from.set(note.layoutKey, { x: note.x, y: note.y });
  const defaults = defaultArchitecturePositions(architecture, notes);
  const to = new Map([...defaults].filter(([key]) => mode === 'all' || selected.has(key)));
  const command = buildMoveCommand(from, to);
  if (!command) return;
  state.setArchitecturePositions(command.to);
  state.pushMoveCommand({ ...command, label: 'Arrange architecture' });
  schedulePersist();
}
