import { cn } from '@codetinder/ui';
import { useAtom } from '@effect/atom-react';
import { HeartBreakIcon } from '@phosphor-icons/react';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useEffect } from 'react';
import { Modal } from '../components/ui/Modal';
import { type ProjectWithState, removeProjectAtom } from '../state/atoms';
import {
  Change,
  dialogBodyClass,
  dialogChangeTextClass,
  dialogConfirmClass,
  dialogErrorClass,
  dialogFootClass,
  dialogGhostClass,
} from './AddProjectDialog';

/**
 * Remove: turns CodeTinder off in a project and opens the MR that removes its config. It closes once
 * the list shows the project past its flow: Removing, or gone.
 */
export const RemoveProjectDialog = ({
  open,
  onOpenChange,
  onClosed,
  project,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onClosed: () => void;
  readonly project: ProjectWithState;
}) => {
  const [result, remove] = useAtom(removeProjectAtom);
  const isRemoving = result.waiting;
  const isRemoved = project.state._tag === 'Removing' || project.state._tag === 'NotAdded';

  useEffect(() => {
    if (isRemoved) onOpenChange(false);
  }, [isRemoved, onOpenChange]);

  const signedOut = 'GitLab signed you out. Sign in again, then remove it.';
  const failure = AsyncResult.builder(result)
    .onErrorTag('SignedOut', () => signedOut)
    .onErrorTag('InvalidToken', () => signedOut)
    .onErrorTag(
      'GitLabCatalogError',
      error => `GitLab wouldn't finish removing it: ${error.message}.`,
    )
    .onFailure(
      () => "GitLab didn't answer this time. Press Remove to try again: it does only what's left.",
    )
    .orNull();

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      onClosed={onClosed}
      title="Breaking up? 💔"
      isBusy={isRemoving}
    >
      <div className={dialogBodyClass}>
        <p className={dialogChangeTextClass}>Here is what removing it from {project.name} does.</p>
        <ul className="my-4 grid gap-5">
          <Change title="Turns CodeTinder off now">
            <p className={dialogChangeTextClass}>
              The codetinder flow goes, with its triggers and its service account. No new merge
              request gets a round.
            </p>
          </Change>
          <Change title="Closes the setup MR, if it's still open">
            <p className={dialogChangeTextClass}>Nothing is left waiting to be merged.</p>
          </Change>
          <Change title="Opens “Remove CodeTinder 💔”">
            <p className={dialogChangeTextClass}>
              A merge request that deletes{' '}
              <code className="font-mono text-[0.9em]">.codetinder/config.json</code>. Merging it
              finishes the removal. Your principles doc and your agent config stay, for you to
              delete if you want.
            </p>
          </Change>
        </ul>
        <p className={dialogChangeTextClass}>Your rounds on codetinder.dev stay there.</p>
        {failure && (
          <p className={dialogErrorClass} role="alert">
            {failure}
          </p>
        )}
      </div>
      <div className={dialogFootClass}>
        <button
          type="button"
          className={cn(dialogGhostClass, 'mr-auto')}
          disabled={isRemoving}
          onClick={() => onOpenChange(false)}
        >
          Keep CodeTinder
        </button>
        <button
          type="button"
          className={dialogConfirmClass}
          disabled={isRemoving}
          onClick={() => remove({ projectId: project.id, fullPath: project.fullPath })}
        >
          {isRemoving ? 'Removing…' : 'Remove'}
          <HeartBreakIcon weight="fill" aria-hidden="true" />
        </button>
      </div>
    </Modal>
  );
};
