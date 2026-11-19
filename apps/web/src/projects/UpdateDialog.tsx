import { useAtom } from '@effect/atom-react';
import { HeartIcon } from '@phosphor-icons/react';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useEffect } from 'react';
import { Modal } from '../components/ui/Modal';
import { type ProjectWithState, updateProjectAtom } from '../state/atoms';
import {
  dialogBodyClass,
  dialogChangeTextClass,
  dialogConfirmClass,
  dialogErrorClass,
  dialogFootClass,
} from './AddProjectDialog';

/** Update: moves a project's flow to the latest version once the developer says so. */
export const UpdateDialog = ({
  open,
  onOpenChange,
  onClosed,
  project,
  consumerId,
  version,
  updateTo,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onClosed: () => void;
  readonly project: ProjectWithState;
  readonly consumerId: string;
  readonly version: string | null;
  readonly updateTo: string;
}) => {
  const [result, update] = useAtom(updateProjectAtom);
  const projectName = project.name;
  const isUpdating = result.waiting;
  const isUpdated = AsyncResult.isSuccess(result) && !isUpdating;

  useEffect(() => {
    if (isUpdated) onOpenChange(false);
  }, [isUpdated, onOpenChange]);

  const signedOut = 'GitLab signed you out. Sign in again, then update it.';
  const failure = AsyncResult.builder(result)
    .onErrorTag('SignedOut', () => signedOut)
    .onErrorTag('InvalidToken', () => signedOut)
    .onErrorTag('GitLabCatalogError', error => `GitLab wouldn't update it: ${error.message}.`)
    .onFailure(() => "GitLab didn't answer this time. Nothing changed: try again.")
    .orNull();

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      onClosed={onClosed}
      title={`Update ${projectName}?`}
      isBusy={isUpdating}
    >
      <div className={dialogBodyClass}>
        <p className={dialogChangeTextClass}>
          Moves the codetinder flow in {projectName} from {version ?? 'its version'} to {updateTo}.
          Nothing in the repo changes.
        </p>
        {failure && (
          <p className={dialogErrorClass} role="alert">
            {failure}
          </p>
        )}
      </div>
      <div className={dialogFootClass}>
        <button
          type="button"
          className={dialogConfirmClass}
          disabled={isUpdating}
          onClick={() =>
            update({
              projectId: project.id,
              consumerId,
              version: updateTo,
              projectFullPath: project.fullPath,
              defaultBranch: project.defaultBranch,
            })
          }
        >
          {isUpdating ? 'Updating…' : 'Update'}
          <HeartIcon weight="fill" aria-hidden="true" />
        </button>
      </div>
    </Modal>
  );
};
