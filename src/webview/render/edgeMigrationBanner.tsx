import { useState } from 'preact/hooks';
import { useAppStore } from '../state/store';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { IconInfo } from '../icons';
import { keepLegacyEdges, showEdgeMigrationNotice, updateLegacyEdges } from '../layout/edgeMigration';

/** One-time notice for a layout whose FK shapes predate the left/right router (spec 05 §Migración). */
export function EdgeMigrationBanner() {
  const show = useAppStore(showEdgeMigrationNotice);
  const [confirmKeep, setConfirmKeep] = useState(false);
  if (!show) return null;
  const keep = () => {
    setConfirmKeep(false);
    keepLegacyEdges();
  };
  return (
    <div class="ddd-edge-migration-bar" role="status" aria-label="Relations drawn by an earlier version">
      <IconInfo size={14} />
      <span class="ddd-edge-migration-bar__label">Relations in this diagram were drawn by an earlier version.</span>
      <Button
        variant="primary"
        size="sm"
        onClick={updateLegacyEdges}
        title="Redraw every relation with the current routing. Colors are kept; Ctrl+Z restores the old lines."
      >
        Update relations
      </Button>
      <Button variant="secondary" size="sm" onClick={() => setConfirmKeep(true)} title="Keep the saved lines and don't ask again">
        Keep
      </Button>
      {/* Keep is the only answer with no undo: the marker it writes silences the notice for good. */}
      <Modal
        open={confirmKeep}
        onClose={() => setConfirmKeep(false)}
        title="Keep the current relations?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmKeep(false)}>Cancel</Button>
            <Button variant="primary" onClick={keep}>Keep</Button>
          </>
        }
      >
        <p>The saved lines stay as they are and this diagram won't ask again.</p>
        <p>
          To get this choice back later, delete <code>"edgeRouting": 2</code> from the diagram's
          {' '}<code>.dbml.layout.json</code> file and reopen the diagram.
        </p>
      </Modal>
    </div>
  );
}
