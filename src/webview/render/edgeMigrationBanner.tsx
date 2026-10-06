import { useAppStore } from '../state/store';
import { Button } from '../ui/Button';
import { IconInfo } from '../icons';
import { keepLegacyEdges, showEdgeMigrationNotice, updateLegacyEdges } from '../layout/edgeMigration';

/** One-time notice for a layout whose FK shapes predate the left/right router (spec 05 §Migración). */
export function EdgeMigrationBanner() {
  const show = useAppStore(showEdgeMigrationNotice);
  if (!show) return null;
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
      <Button variant="secondary" size="sm" onClick={keepLegacyEdges} title="Keep the saved lines and don't ask again">
        Keep
      </Button>
    </div>
  );
}
