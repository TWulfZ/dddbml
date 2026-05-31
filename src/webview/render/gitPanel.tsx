import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { store, useAppStore } from '../state/store';
import { postToHost } from '../vscode';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Search } from '../ui/Search';
import { IconGitCommit, IconHistory, IconDiff, IconStash, IconGitBranch, IconReset } from '../icons';
import type { GitFileStatus, GitStatusSummary } from '../../shared/types';

type Section = 'commit' | 'history' | 'diff' | 'stash';

const SECTIONS: { id: Section; label: string; icon: VNode }[] = [
  { id: 'commit', label: 'Commit', icon: <IconGitCommit size={14} /> },
  { id: 'history', label: 'History', icon: <IconHistory size={14} /> },
  { id: 'diff', label: 'Diff', icon: <IconDiff size={14} /> },
  { id: 'stash', label: 'Stash', icon: <IconStash size={14} /> },
];

const STATUS_LABEL: Record<GitFileStatus, string> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  untracked: 'untracked',
  renamed: 'renamed',
};

function basename(relpath: string): string {
  const i = relpath.lastIndexOf('/');
  return i < 0 ? relpath : relpath.slice(i + 1);
}

function close() {
  store.getState().setGitPanelOpen(false);
}

/**
 * Git panel (spec 16) — the destination of the app-menu "Git" slot. Two-pane modal cloned from the
 * settings panel shell (`.ddd-settings__*` = the generic two-pane layout). All actions are scoped to
 * the diagram files only (the `.dbml` + its layout sidecar).
 */
export function GitPanel() {
  const open = useAppStore((s) => s.gitPanelOpen);
  const gitStatus = useAppStore((s) => s.gitStatus);
  const [active, setActive] = useState<Section>('commit');

  // Refresh status (cheap, host-side) each time the panel opens.
  useEffect(() => {
    if (open) postToHost({ type: 'git:requestStatus' });
  }, [open]);

  return (
    <Modal open={open} onClose={close} title="Git" wide>
      <div class="ddd-settings">
        <div class="ddd-settings__rail" role="tablist" aria-orientation="vertical" aria-label="Git actions">
          {SECTIONS.map((sec) => (
            <button
              key={sec.id}
              type="button"
              role="tab"
              aria-selected={active === sec.id}
              class={`ddd-settings__rail-item${active === sec.id ? ' is-active' : ''}`}
              onClick={() => setActive(sec.id)}
            >
              {sec.icon}
              <span>{sec.label}</span>
            </button>
          ))}
        </div>

        <div class="ddd-settings__content">
          {!gitStatus?.inRepo ? (
            <NoRepoNotice />
          ) : active === 'commit' ? (
            <CommitPane status={gitStatus} />
          ) : active === 'stash' ? (
            <StashPane status={gitStatus} />
          ) : active === 'history' ? (
            <HistoryPane />
          ) : (
            <DiffPane status={gitStatus} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function PanelHead({ icon, title, children }: { icon: VNode; title: string; children?: VNode }) {
  return (
    <div class="ddd-settings__panel-head">
      <span class="ddd-settings__panel-title">
        {icon}
        {title}
      </span>
      {children ? <span class="ddd-settings__panel-actions">{children}</span> : null}
    </div>
  );
}

/** Branch chip + a one-line summary of how many diagram files changed. */
function BranchRow({ status }: { status: GitStatusSummary }) {
  return (
    <div class="ddd-git-branch">
      <IconGitBranch size={13} />
      <span class="ddd-git-branch__name">{status.branch ?? '(detached)'}</span>
      <span class="ddd-git-branch__sep">·</span>
      <span class="ddd-git-branch__count">
        {status.dirty ? `${status.files.length} changed file(s)` : 'no changes'}
      </span>
    </div>
  );
}

function FileList({ status }: { status: GitStatusSummary }) {
  if (!status.dirty) {
    return <p class="ddd-git-empty">Diagram is clean — nothing to commit.</p>;
  }
  return (
    <ul class="ddd-git-files">
      {status.files.map((f) => (
        <li key={f.relpath} class="ddd-git-file">
          <span class="ddd-git-file__name" title={f.relpath}>{basename(f.relpath)}</span>
          <span class={`ddd-git-pill is-${f.status}`}>{STATUS_LABEL[f.status]}</span>
        </li>
      ))}
    </ul>
  );
}

function CommitPane({ status }: { status: GitStatusSummary }) {
  const busy = useAppStore((s) => s.gitBusy);
  const [message, setMessage] = useState('');
  const [confirmRevert, setConfirmRevert] = useState(false);
  const canCommit = status.dirty && message.trim().length > 0 && !busy;

  const commit = () => {
    if (!canCommit) return;
    store.getState().setGitBusy(true);
    postToHost({ type: 'git:commit', payload: { message: message.trim() } });
    setMessage('');
  };

  const revert = () => {
    setConfirmRevert(false);
    store.getState().setGitBusy(true);
    postToHost({ type: 'git:restore' });
  };

  const stashInstead = () => {
    setConfirmRevert(false);
    store.getState().setGitBusy(true);
    postToHost({ type: 'git:stashPush', payload: {} });
  };

  return (
    <section class="ddd-settings__panel" role="tabpanel">
      <PanelHead icon={<IconGitCommit size={14} />} title="Commit" />
      <BranchRow status={status} />
      <FileList status={status} />
      <label class="ddd-field">
        <span class="ddd-field__label">Commit message</span>
        <input
          class="ddd-field__control"
          type="text"
          value={message}
          placeholder="Describe the diagram change…"
          disabled={!status.dirty || busy}
          onInput={(e) => setMessage((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        />
      </label>
      <div class="ddd-git-actions">
        <Button variant="danger" onClick={() => setConfirmRevert(true)} disabled={!status.dirty || busy}>
          <IconReset size={13} /> Discard changes
        </Button>
        <Button variant="primary" onClick={commit} disabled={!canCommit}>
          {busy ? 'Committing…' : 'Commit'}
        </Button>
      </div>

      <Modal
        open={confirmRevert}
        onClose={() => setConfirmRevert(false)}
        title="Discard diagram changes"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRevert(false)}>Cancel</Button>
            <Button variant="secondary" onClick={stashInstead}>Stash instead</Button>
            <Button variant="danger" onClick={revert}>Discard (permanent)</Button>
          </>
        }
      >
        <p class="ddd-git-warn">
          This discards the uncommitted changes to the diagram files and restores them to HEAD.
          <strong> This cannot be undone.</strong>
        </p>
        <p class="ddd-git-empty">
          Only want to set them aside temporarily? Use <strong>Stash</strong> — your changes are saved
          and can be restored later.
        </p>
      </Modal>
    </section>
  );
}

function StashPane({ status }: { status: GitStatusSummary }) {
  const busy = useAppStore((s) => s.gitBusy);
  const stashes = useAppStore((s) => s.gitStashes);

  // Stashes are repo-global — refresh the list whenever this pane mounts.
  useEffect(() => {
    postToHost({ type: 'git:requestStashes' });
  }, []);

  const push = () => {
    store.getState().setGitBusy(true);
    postToHost({ type: 'git:stashPush', payload: {} });
  };
  const apply = (ref: string) => {
    store.getState().setGitBusy(true);
    postToHost({ type: 'git:stashApply', payload: { ref } });
  };
  const pop = (ref: string) => {
    store.getState().setGitBusy(true);
    postToHost({ type: 'git:stashPop', payload: { ref } });
  };

  return (
    <section class="ddd-settings__panel" role="tabpanel">
      <PanelHead icon={<IconStash size={14} />} title="Stash">
        <Button variant="secondary" size="sm" onClick={push} disabled={!status.dirty || busy}>
          Stash changes
        </Button>
      </PanelHead>
      {stashes.length === 0 ? (
        <p class="ddd-git-empty">No stashes.</p>
      ) : (
        <ul class="ddd-git-files">
          {stashes.map((s) => (
            <li key={s.ref} class="ddd-git-file">
              <span class="ddd-git-file__name" title={s.ref}>
                <span class="ddd-git-stash__ref">{s.ref}</span> {s.message}
              </span>
              <span class="ddd-git-stash__ops">
                <Button variant="ghost" size="sm" onClick={() => apply(s.ref)} disabled={busy} title="Apply (keep in list)">
                  Apply
                </Button>
                <Button variant="ghost" size="sm" onClick={() => pop(s.ref)} disabled={busy} title="Apply and drop from list">
                  Pop
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryPane() {
  const commits = useAppStore((s) => s.gitCommits);
  const merging = useAppStore((s) => s.mergeConflicts != null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    postToHost({ type: 'git:requestCommits' });
  }, []);

  const enter = (sha: string, label: string) => {
    if (merging) return;
    store.getState().setGitPanelOpen(false);
    postToHost({ type: 'git:timeTravel:enter', payload: { sha, label } });
  };

  const q = filter.trim().toLowerCase();
  const shown = q
    ? commits.filter((c) => `${c.subject} ${c.author} ${c.shortSha}`.toLowerCase().includes(q))
    : commits;

  return (
    <section class="ddd-settings__panel" role="tabpanel">
      <PanelHead icon={<IconHistory size={14} />} title="Explore versions" />
      {merging ? (
        <p class="ddd-git-empty">Resolve the active merge before exploring versions.</p>
      ) : (
        <>
          <p class="ddd-git-empty">
            Open an earlier version <strong>read-only</strong> over the diagram. It never touches your
            files or the editor.
          </p>
          <Search value={filter} onInput={setFilter} placeholder="Filter commits…" />
          {commits.length === 0 ? (
            <p class="ddd-git-empty">No commits touch the diagram.</p>
          ) : (
            <ul class="ddd-git-commits">
              {shown.map((c) => (
                <li key={c.sha}>
                  <button
                    type="button"
                    class="ddd-git-commit"
                    onClick={() => enter(c.sha, `${c.shortSha} · ${c.subject}`)}
                    title={`${c.sha}\n${c.author} · ${c.date}`}
                  >
                    <span class="ddd-git-commit__subject">{c.subject || '(no message)'}</span>
                    <span class="ddd-git-commit__meta">
                      <span class="ddd-git-commit__sha">{c.shortSha}</span>
                      <span>{c.author}</span>
                      <span>{c.date}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function NoRepoNotice() {
  return (
    <section class="ddd-settings__panel" role="tabpanel">
      <PanelHead icon={<IconGitCommit size={14} />} title="Git" />
      <p class="ddd-git-empty">
        This diagram is not inside a git repository. Initialize one (<code>git init</code>) to commit,
        explore versions, and view diffs.
      </p>
    </section>
  );
}

function DiffPane({ status }: { status: GitStatusSummary }) {
  const merging = useAppStore((s) => s.mergeConflicts != null);

  const showDiff = () => {
    if (merging) return;
    store.getState().setGitPanelOpen(false);
    postToHost({ type: 'git:diff:enter' });
  };

  return (
    <section class="ddd-settings__panel" role="tabpanel">
      <PanelHead icon={<IconDiff size={14} />} title="Diff" />
      {merging ? (
        <p class="ddd-git-empty">Resolve the active merge before viewing a diff.</p>
      ) : (
        <>
          <p class="ddd-git-empty">
            Overlay the changes against the last commit (HEAD) on the diagram. Changed tables are
            highlighted; hover one to compare its <strong>Previous</strong> and <strong>Current</strong>
            columns side by side.
          </p>
          <BranchRow status={status} />
          <div class="ddd-git-actions">
            <Button variant="primary" onClick={showDiff}>
              Diff against HEAD
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
