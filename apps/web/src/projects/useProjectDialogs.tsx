import { useCallback, useState } from 'react';
import type { ProjectWithState } from '../state/atoms';
import { AddProjectDialog } from './AddProjectDialog';
import type { ProjectAction } from './ProjectStatus';
import { RemoveProjectDialog } from './RemoveProjectDialog';
import { UpdateDialog } from './UpdateDialog';

type ProjectDialog = { readonly kind: 'add' } | ProjectAction;

/**
 * The projects pages' dialogs, one open at a time. Closing hides it first; it leaves once its exit
 * animation ends. Each shows its project as `projects` has it now, so a change lands in it.
 */
export const useProjectDialogs = (projects: readonly ProjectWithState[]) => {
  const [dialog, setDialog] = useState<ProjectDialog | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const onClosed = useCallback(() => setDialog(null), []);
  const modal = { open: isOpen, onOpenChange: setIsOpen, onClosed };
  const latest = (project: ProjectWithState) =>
    projects.find(({ id }) => id === project.id) ?? project;

  const dialogElement = (() => {
    switch (dialog?.kind) {
      case undefined:
        return null;
      case 'add':
        return <AddProjectDialog {...modal} projects={projects} />;
      case 'finish':
        return <AddProjectDialog {...modal} projects={projects} project={latest(dialog.project)} />;
      case 'remove':
        return <RemoveProjectDialog {...modal} project={latest(dialog.project)} />;
      case 'update':
        return (
          <UpdateDialog
            {...modal}
            project={latest(dialog.project)}
            consumerId={dialog.consumerId}
            version={dialog.version}
            updateTo={dialog.updateTo}
          />
        );
    }
  })();

  return {
    openDialog: (next: ProjectDialog) => {
      setDialog(next);
      setIsOpen(true);
    },
    dialogElement,
  };
};
