import { Component, type ComponentChildren } from 'preact';
import { postToHost } from '../vscode';
import { Button } from './Button';

interface ErrorBoundaryProps {
  /** Short label for the subtree, used in the fallback and the host log (e.g. "canvas"). */
  scope: string;
  children?: ComponentChildren;
}

interface ErrorBoundaryState {
  message: string | null;
}

/**
 * Preact aborts the whole commit when a render throws and nothing catches it; siblings diffed
 * after the throwing subtree are left half-updated (this is how the floating chrome ended up
 * "torn" on large diagrams). Each boundary confines that failure to its own subtree, reports it
 * to the host log, and offers a retry that re-mounts the children.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: null };

  override componentDidCatch(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    postToHost({ type: 'error:log', payload: { message: `[${this.props.scope}] ${err.message}`, stack: err.stack } });
    this.setState({ message: err.message });
  }

  override render() {
    if (this.state.message === null) return this.props.children;
    return (
      <div class="ddd-banner" role="alert">
        Render error in {this.props.scope}: {this.state.message}
        <Button variant="secondary" size="sm" onClick={() => this.setState({ message: null })}>
          Retry
        </Button>
      </div>
    );
  }
}
