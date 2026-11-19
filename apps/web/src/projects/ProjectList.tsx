import { GITLAB_BASE_URL } from '@codetinder/gitlab';
import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import type { ProjectWithState } from '../state/atoms';
import { type ProjectAction, ProjectCallToAction, ProjectStatus } from './ProjectStatus';

/** The projects CodeTinder is in, each with where it stands and the one thing it needs. */
export const ProjectList = ({
  projects,
  onAction,
}: {
  readonly projects: readonly ProjectWithState[];
  readonly onAction: (action: ProjectAction) => void;
}) => (
  // One white card holding every match, hairlines between them.
  <ul className="my-4 overflow-hidden rounded-[16px] bg-card shadow-lift">
    {projects.map(project => (
      <li
        key={project.id}
        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-3 px-6 py-5 not-first:border-t not-first:border-rule max-sm:grid-cols-[minmax(0,1fr)] max-sm:px-5 max-sm:py-[1.1rem]"
      >
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[0.15rem]">
          <Link
            className="max-w-full justify-self-start truncate text-[1.2rem] font-bold text-ink hover:text-lipstick hover:underline"
            to="/projects/$id"
            params={{ id: String(project.id) }}
          >
            {project.name}
          </Link>
          <a
            className="flex max-w-full items-center gap-[0.3rem] justify-self-start text-[0.9rem] text-ink-faint hover:text-lipstick hover:underline"
            href={`${GITLAB_BASE_URL}/${project.fullPath}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`${project.fullPath} on GitLab`}
            title={project.fullPath}
          >
            <span className="truncate">{project.fullPath}</span>
            <ArrowSquareOutIcon className="flex-none" aria-hidden="true" />
          </a>
          <ProjectStatus state={project.state} className="mt-[0.45rem]" />
        </div>
        <ProjectCallToAction project={project} onAction={onAction} />
      </li>
    ))}
  </ul>
);
