import { GITLAB_BASE_URL } from '@codetinder/gitlab';
import { cn } from '@codetinder/ui';
import { ArrowSquareOutIcon, CaretLeftIcon } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import type { ProjectWithState } from '../state/atoms';
import { LearnedPrinciplesSection } from './LearnedPrinciplesSection';
import { ProjectMenu } from './ProjectMenu';
import { isRemovable, ProjectCallToAction, ProjectStatus } from './ProjectStatus';
import { ProjectsLayout, titleClass } from './ProjectsLayout';
import { RoundStartsSection } from './RoundStartsSection';
import { SweepSection } from './SweepSection';
import { useProjectDialogs } from './useProjectDialogs';

const quietLinkClass =
  'inline-flex items-center gap-[0.35rem] font-semibold text-wine hover:text-lipstick hover:underline hover:underline-offset-[0.2em] [&_svg]:flex-none';

/** One match: where it stands and what it needs, then the taste CodeTinder has learned there. */
export const ProjectScreen = ({
  project,
  projects,
}: {
  readonly project: ProjectWithState;
  readonly projects: readonly ProjectWithState[];
}) => {
  const { openDialog, dialogElement } = useProjectDialogs(projects);
  const { state } = project;
  // The setup MR of a half-done add, which the call to action (Finish setup) doesn't open.
  const setupMergeRequestUrl = state._tag === 'Unfinished' ? state.setupMergeRequestUrl : null;

  return (
    <ProjectsLayout>
      <Link className={quietLinkClass} to="/projects">
        <CaretLeftIcon weight="bold" aria-hidden="true" />
        Your matches
      </Link>
      <div className="mt-[clamp(1rem,3vw,1.5rem)] grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4">
        <h1 className={cn(titleClass, '[overflow-wrap:anywhere]')}>{project.name}</h1>
        {isRemovable(state) && (
          <ProjectMenu
            projectName={project.name}
            onRemove={() => openDialog({ kind: 'remove', project })}
          />
        )}
      </div>
      <a
        className={cn(quietLinkClass, 'mt-1 max-w-full text-[1.05rem]')}
        href={`${GITLAB_BASE_URL}/${project.fullPath}`}
        target="_blank"
        rel="noreferrer"
        aria-label={`${project.fullPath} on GitLab`}
      >
        <span className="truncate">{project.fullPath}</span>
        <ArrowSquareOutIcon aria-hidden="true" />
      </a>

      <section
        className="mt-[clamp(1.25rem,4vw,2rem)] grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-3 rounded-[16px] bg-card px-6 py-5 shadow-card max-sm:grid-cols-[minmax(0,1fr)] max-sm:px-5 max-sm:py-[1.1rem]"
        aria-label="Where it stands"
      >
        <div className="grid min-w-0 gap-2">
          <ProjectStatus state={state} />
          {setupMergeRequestUrl !== null && (
            <a
              className={cn(quietLinkClass, 'ml-[1.45rem] justify-self-start text-[0.95rem]')}
              href={setupMergeRequestUrl}
              target="_blank"
              rel="noreferrer"
            >
              Its setup MR
              <ArrowSquareOutIcon aria-hidden="true" />
            </a>
          )}
        </div>
        <ProjectCallToAction project={project} onAction={openDialog} />
      </section>

      <RoundStartsSection project={project} />
      <SweepSection project={project} />
      <LearnedPrinciplesSection project={project} />
      {dialogElement}
    </ProjectsLayout>
  );
};
