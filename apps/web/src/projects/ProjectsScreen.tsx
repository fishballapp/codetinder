import { cn, pillVariants } from '@codetinder/ui';
import heartBeMine from '@codetinder/ui/plates/heart-be-mine.webp';
import { HeartIcon } from '@phosphor-icons/react';
import type { ProjectWithState } from '../state/atoms';
import { ProjectList } from './ProjectList';
import { leadClass, ProjectsLayout, titleClass } from './ProjectsLayout';
import { useProjectDialogs } from './useProjectDialogs';

/** The developer's matches: the projects with CodeTinder, and adding another. */
export const ProjectsScreen = ({
  projects,
}: {
  readonly projects: readonly ProjectWithState[];
}) => {
  const { openDialog, dialogElement } = useProjectDialogs(projects);
  const openAdd = () => openDialog({ kind: 'add' });
  const matches = projects.filter(({ state }) => state._tag !== 'NotAdded');
  const addLabel = (
    <>
      Add a project
      <HeartIcon weight="fill" aria-hidden="true" />
    </>
  );

  return (
    <ProjectsLayout
      action={
        matches.length > 0 && (
          <button
            type="button"
            className={cn(
              pillVariants({ size: 'sm' }),
              'max-sm:px-[1.1rem] max-sm:py-[0.55rem] max-sm:text-[0.95rem]',
            )}
            onClick={openAdd}
          >
            {addLabel}
          </button>
        )
      }
    >
      {matches.length === 0 ? (
        // No matches: the "be mine" candy asks the question.
        <section className="mt-[clamp(0rem,4vh,3rem)] grid justify-items-center text-center">
          <img
            className="mb-2 w-[clamp(9rem,22vw,13rem)] animate-float motion-reduce:animate-none"
            src={heartBeMine}
            width={480}
            height={480}
            alt=""
          />
          <h1 className={titleClass}>No matches yet</h1>
          <p className={cn(leadClass, 'mx-auto')}>
            Add CodeTinder to a project and its merge requests get rounds to swipe.
          </p>
          <button type="button" className={pillVariants({ size: 'lg' })} onClick={openAdd}>
            {addLabel}
          </button>
        </section>
      ) : (
        <>
          <h1 className={titleClass}>Your matches</h1>
          <p className={leadClass}>Where your MRs get rounds to swipe.</p>
          <ProjectList projects={matches} onAction={openDialog} />
        </>
      )}
      {dialogElement}
    </ProjectsLayout>
  );
};
