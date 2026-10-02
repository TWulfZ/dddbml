import { store } from './state/store';
import { fitToContent, resetView, zoomAtCenter } from './render/viewport';
import { runSmartLayout, runEdgeOrdering } from './layout/smartLayout';
import { resetLayout } from './layout/resetLayout';
import { focusTable } from './render/focusTable';
import { schedulePersist } from './persistence';
import type { HostToWebview } from '../shared/types';

/** Applies one host → webview message to the store (split from `main.tsx` so it can be tested). */
export function handleHostMessage(msg: HostToWebview): void {
  const state = store.getState();
  switch (msg.type) {
    case 'schema:update':
      state.setSchema(msg.payload.schema, msg.payload.parseError);
      return;
    case 'layout:loaded':
      state.setLayout(msg.payload);
      return;
    case 'layout:external-change':
      // Disk changed (also: a reload deferred by an overlay, applied at its exit): undo history
      // recorded against the old layout no longer applies, stashed or not (spec 11).
      state.dropHistoryStash();
      state.setLayout(msg.payload);
      return;
    case 'theme:change':
      state.setTheme(msg.payload.kind);
      return;
    case 'settings:loaded':
      state.setSettings(msg.payload);
      return;
    case 'exporters:list':
      state.setExporters(msg.payload.exporters);
      return;
    case 'export:prompt':
      state.setExportPromptOpen(true);
      return;
    case 'export:result':
      state.setExportPromptOpen(false);
      return;
    case 'exportImage:prompt':
      state.setExportImagePromptOpen(true);
      return;
    case 'image:result':
      // Only close on success; on failure/cancel keep the dialog open so the user can retry.
      if (msg.payload.ok) state.setExportImagePromptOpen(false);
      return;
    case 'viewport:command': {
      const el = document.querySelector<HTMLElement>('.ddd-viewport');
      if (!el) return;
      const step = state.settings.zoomStep;
      switch (msg.payload.action) {
        case 'zoomIn':       zoomAtCenter(step, el); return;
        case 'zoomOut':      zoomAtCenter(1 / step, el); return;
        case 'resetView':    resetView(); return;
        case 'fitToContent': fitToContent(el); return;
      }
      return;
    }
    case 'command:autoArrange':
      void runSmartLayout(msg.payload.mode, {
        orderEdges: msg.payload.orderEdges,
        preserveManualEdges: msg.payload.preserveManualEdges,
      });
      return;
    case 'command:orderEdges':
      void runEdgeOrdering({ preserveManual: msg.payload.preserveManualEdges });
      return;
    case 'command:resetLayout':
      resetLayout();
      return;
    case 'merge:begin':
      state.beginMerge(msg.payload.conflicts, msg.payload.error);
      return;
    case 'merge:applyFailed':
      state.setMergeApplying(false);
      return;
    case 'merge:done':
      state.endMerge();
      return;
    case 'git:status':
      state.setGitStatus(msg.payload);
      return;
    case 'git:commitResult':
      state.setGitBusy(false);
      if (msg.payload.ok) state.noteGitCommitOk();
      return;
    case 'git:stashes':
      state.setGitStashes(msg.payload.stashes);
      return;
    case 'git:opResult':
      state.setGitBusy(false);
      return;
    case 'git:commits':
      state.setGitCommits(msg.payload.commits);
      return;
    case 'git:timeTravel:enter':
      // Read-only first: entering stashes the working history, which swapping in the past
      // revision's schema + layout would otherwise wipe (F76).
      state.enterTimeTravel(msg.payload.rev, msg.payload.label);
      state.setSchema(msg.payload.schema, null);
      state.setLayout(msg.payload.layout);
      return;
    case 'git:timeTravel:exit':
    case 'git:diff:exit':
      // The host posts this after the working schema/layout, so read-only ends with them on screen.
      state.exitGitView();
      return;
    case 'git:diff:enter':
      // Keep the current (working) schema on screen; overlay the diff and enter read-only.
      state.enterDiff(msg.payload.baseLabel, msg.payload.headLabel, msg.payload.diff);
      return;
    case 'layout:place': {
      // Arrives before the table does: held now, auto-placement then finds it already positioned.
      const { table, x, y } = msg.payload;
      state.placeTable(table, x, y);
      if (store.getState().positions !== state.positions) schedulePersist();
      return;
    }
    case 'diagram:focusTable':
      focusTable(msg.payload.table);
      return;
    case 'schema:applied':
      state.pushSchemaCommand(msg.payload.id, msg.payload.label);
      return;
    case 'schema:discarded':
      state.dropSchemaCommand(msg.payload.id);
      return;
  }
}
