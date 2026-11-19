import { Collapsible } from '@base-ui/react/collapsible';
import { Combobox } from '@base-ui/react/combobox';
import { cn, pillVariants } from '@codetinder/ui';
import { useAtom, useAtomRefresh, useAtomValue } from '@effect/atom-react';
import { CaretRightIcon, HeartIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import { type ReactNode, type RefObject, useRef, useState } from 'react';
import { Modal } from '../components/ui/Modal';
import type { AddBlock } from '../state/addability';
import { addProjectAtom, type ProjectWithState, setupPlanAtom } from '../state/atoms';
import { MatchMoment } from './MatchMoment';

// The step-two look, shared with UpdateDialog so the two dialogs read alike.
export const dialogBodyClass =
  'min-h-0 flex-1 overflow-auto overscroll-contain px-7 pt-5 pb-2 max-sm:px-5';
export const dialogChangeTextClass =
  'mt-[0.2rem] text-[1rem] leading-normal text-pretty text-ink-soft';
export const dialogErrorClass =
  'mt-4 rounded-xl bg-petal-wash px-4 py-3 text-[0.95rem] leading-[1.45] font-semibold text-wine';
export const dialogFootClass =
  'flex flex-none items-center justify-end gap-3 border-t border-rule px-7 pt-4 pb-6 max-sm:px-5 max-sm:pb-5';
export const dialogConfirmClass = cn(
  pillVariants(),
  'px-7 py-[0.85rem] text-[1.05rem] max-sm:flex-1 max-sm:justify-center',
);
// The step's secondary button: a Wine text link, not a pill.
export const dialogGhostClass =
  'cursor-pointer rounded-pill px-4 py-[0.7rem] font-semibold text-wine not-disabled:hover:underline not-disabled:hover:underline-offset-[0.2em] disabled:cursor-default disabled:opacity-50';

/** A project that can't take CodeTinder shows this in place of its path: the reason, plainly. */
const blockReasonCopy: Record<AddBlock, string> = {
  ScheduledForDeletion: "Scheduled for deletion, so it can't take CodeTinder",
  NoAgentPlatform: "Needs GitLab Duo's Agent Platform (Premium or Ultimate), not available here",
  EmptyRepository: 'Empty repository: push a first commit, then add it',
};

/** What adding still has to do in a project: everything, or what a half-done add left. */
const remainingSetup = ({ state }: ProjectWithState) => {
  if (state._tag === 'NotAdded') {
    return { needsFlow: true, needsSetupMergeRequest: true, setupMergeRequestUrl: null };
  }
  if (state._tag === 'Unfinished') return state;
  return { needsFlow: false, needsSetupMergeRequest: false, setupMergeRequestUrl: null };
};

/** Every word of the query appears in the project's name or path. */
const matchesQuery = (project: ProjectWithState, query: string) => {
  const haystack = `${project.name} ${project.fullPath}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every(word => haystack.includes(word));
};

/** Step one: find the project among those without CodeTinder, by typing, arrows and Enter. */
const PickProject = ({
  projects,
  inputRef,
  onPick,
}: {
  readonly projects: readonly ProjectWithState[];
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onPick: (project: ProjectWithState) => void;
}) => {
  if (projects.length === 0) {
    return (
      <p className="px-7 pt-5 pb-7 text-[1.05rem] text-ink-soft max-sm:px-5">
        Every project you can push to already has CodeTinder. Smitten, all of them.
      </p>
    );
  }
  // Addable projects first, then the ones that can't take CodeTinder, disabled, each with its reason.
  const addable = projects.filter(({ addability }) => addability._tag === 'Addable');
  const blocked = projects.filter(({ addability }) => addability._tag === 'Blocked');
  // Search, then the list scrolling under it.
  return (
    <div className="flex flex-1 flex-col gap-4 min-h-0 px-7 pt-5 pb-7 max-sm:px-5">
      <Combobox.Root
        inline
        open
        autoHighlight
        items={[...addable, ...blocked]}
        filter={matchesQuery}
        itemToStringLabel={(project: ProjectWithState) => project.name}
        isItemEqualToValue={(a: ProjectWithState, b: ProjectWithState) => a.id === b.id}
        onValueChange={(project: ProjectWithState | null) => {
          if (project?.addability._tag === 'Addable') onPick(project);
        }}
      >
        <Combobox.InputGroup className="flex flex-none items-center gap-[0.6rem] rounded-[0.9rem] border-2 border-petal-soft px-4 text-ink-faint [transition:border-color_160ms_var(--ease-out)] focus-within:border-hot-pink">
          <MagnifyingGlassIcon className="size-[1.15rem] flex-none" aria-hidden="true" />
          <Combobox.Input
            ref={inputRef}
            className="min-w-0 flex-1 py-[0.8rem] text-[1.05rem] text-ink outline-none placeholder:text-ink-faint"
            placeholder="Search your projects"
            aria-label="Search your projects"
          />
        </Combobox.InputGroup>
        <Combobox.Empty className="py-2 text-[1.05rem] text-ink-soft empty:hidden">
          No project matches that.
        </Combobox.Empty>
        {addable.length === 0 && (
          <p className="text-[1.05rem] text-ink-soft">
            None of these can take CodeTinder yet. Each one says why.
          </p>
        )}
        <Combobox.List className="-mx-3 min-h-0 overflow-auto overscroll-contain">
          {(project: ProjectWithState) => (
            <Combobox.Item
              key={project.id}
              value={project}
              disabled={project.addability._tag === 'Blocked'}
              className="group flex cursor-pointer items-center gap-4 rounded-[0.9rem] p-3 text-ink outline-none [transition:background-color_160ms_var(--ease-out)] data-[disabled]:cursor-default data-[highlighted]:not-data-[disabled]:bg-petal-wash"
            >
              <span className="grid min-w-0 flex-1 gap-[0.1rem]">
                <span className="text-[1.05rem] font-bold group-data-[disabled]:text-ink-faint">
                  {project.name}
                </span>
                {/* A reason wraps: cut short, it hides the part that says what to do. */}
                <span
                  className={cn(
                    'text-[0.9rem] text-ink-faint',
                    project.addability._tag === 'Blocked' ? 'text-pretty' : 'truncate',
                  )}
                >
                  {project.addability._tag === 'Blocked'
                    ? blockReasonCopy[project.addability.reason]
                    : project.fullPath}
                </span>
              </span>
              <CaretRightIcon
                className="size-[1.15rem] flex-none text-petal [transition:translate_200ms_var(--ease-spring)] group-data-[disabled]:invisible group-data-[highlighted]:translate-x-[0.2rem] group-data-[highlighted]:text-lipstick"
                aria-hidden="true"
              />
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Root>
    </div>
  );
};

/**
 * The files the setup MR adds or updates, each opening to show exactly what it adds: a new file
 * whole, the section it appends to an existing one. Then any file it leaves, and why.
 */
const SetupFiles = ({ projectId }: { readonly projectId: number }) => {
  const plan = useAtomValue(setupPlanAtom(projectId));
  const refresh = useAtomRefresh(setupPlanAtom(projectId));
  return AsyncResult.builder(plan)
    .onInitial(() => (
      <p className="mt-3 text-[0.95rem] text-ink-faint">Reading the project's files…</p>
    ))
    .onSuccess(({ files, untouched, notices }) => (
      <>
        <ul className="mt-3 grid gap-[0.4rem]">
          {files.map(file => (
            <li key={file.path} className="min-w-0">
              <Collapsible.Root className="rounded-xl bg-card-sunk">
                <Collapsible.Trigger className="group flex w-full cursor-pointer items-center gap-2 rounded-xl px-[0.8rem] py-[0.6rem] text-left">
                  <CaretRightIcon
                    className="size-4 flex-none text-ink-faint [transition:rotate_220ms_var(--ease-spring)] group-data-[panel-open]:rotate-90"
                    aria-hidden="true"
                  />
                  <code className="truncate font-mono text-[0.9rem] text-ink [transition:color_160ms_var(--ease-out)] group-hover:text-lipstick">
                    {file.path}
                  </code>
                  {file.action === 'update' && (
                    <span className="ml-auto flex-none text-[0.85rem] text-ink-faint">
                      {file.summary}
                    </span>
                  )}
                </Collapsible.Trigger>
                <Collapsible.Panel className="h-[var(--collapsible-panel-height)] overflow-hidden [transition:height_220ms_var(--ease-out)] data-[ending-style]:h-0 data-[starting-style]:h-0">
                  <pre className="overflow-x-auto pt-1 pr-4 pb-4 pl-[2.3rem] font-mono text-[0.8rem] leading-[1.6] text-ink">
                    {file.action === 'update' ? file.added : file.content}
                  </pre>
                </Collapsible.Panel>
              </Collapsible.Root>
            </li>
          ))}
        </ul>
        {untouched.map(({ path, reason }) => (
          <p key={path} className="mt-2 text-[0.9rem] text-ink-faint">
            <code className="font-mono text-ink">{path}</code> isn't updated: {reason}.
          </p>
        ))}
        {notices.map(notice => (
          <p key={notice} className="mt-2 text-[0.9rem] text-ink-faint">
            {notice.split(/`([^`]+)`/).map((part, index) =>
              index % 2 === 1 ? (
                <code key={part} className="font-mono text-ink">
                  {part}
                </code>
              ) : (
                part
              ),
            )}
          </p>
        ))}
      </>
    ))
    .onFailure(() => (
      <p className={dialogErrorClass} role="alert">
        Couldn't read the project's files.{' '}
        <button
          type="button"
          className="cursor-pointer text-lipstick underline underline-offset-[0.2em]"
          onClick={refresh}
        >
          Try again
        </button>
      </p>
    ))
    .render();
};

/** One change a dialog's step will make: a heart, a bold title and what it means. */
export const Change = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) => (
  <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-[0.85rem]">
    <HeartIcon className="mt-[0.15rem] size-5 text-lipstick" weight="fill" aria-hidden="true" />
    <div>
      <p className="text-[1.1rem] font-bold">{title}</p>
      {children}
    </div>
  </li>
);

/**
 * Add a project: pick one without CodeTinder, read what will change, add it, celebrate. Opened on
 * a half-done project (`project`), it goes straight to what is left.
 */
export const AddProjectDialog = ({
  open,
  onOpenChange,
  onClosed,
  projects,
  project: given,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onClosed: () => void;
  readonly projects: readonly ProjectWithState[];
  readonly project?: ProjectWithState;
}) => {
  const [pickedId, setPickedId] = useState<number | null>(null);
  const [result, add] = useAtom(addProjectAtom);
  const searchRef = useRef<HTMLInputElement>(null);
  const project = given ?? projects.find(({ id }) => id === pickedId);
  const isAdding = result.waiting;
  const close = () => onOpenChange(false);
  const modal = { open, onOpenChange, onClosed };

  if (project === undefined) {
    return (
      <Modal {...modal} title="Add a project" initialFocus={searchRef}>
        <PickProject
          projects={projects.filter(({ state }) => state._tag === 'NotAdded')}
          inputRef={searchRef}
          onPick={picked => {
            add(Atom.Reset);
            setPickedId(picked.id);
          }}
        />
      </Modal>
    );
  }

  const added =
    AsyncResult.isSuccess(result) && !isAdding && result.value.projectId === project.id
      ? result.value
      : null;
  if (added) {
    return (
      <Modal {...modal} label={`CodeTinder added to ${project.name}`}>
        <MatchMoment
          projectName={project.name}
          setupMergeRequestUrl={added.setupMergeRequestUrl}
          onDone={close}
        />
      </Modal>
    );
  }

  const { needsFlow, needsSetupMergeRequest, setupMergeRequestUrl } = remainingSetup(project);
  const isFinishing = project.state._tag === 'Unfinished';
  const confirmLabel = isFinishing ? 'Finish it' : 'Add it';
  const signedOut = 'GitLab signed you out. Sign in again, then add it.';
  const failure = AsyncResult.builder(result)
    .onErrorTag('SignedOut', () => signedOut)
    .onErrorTag('InvalidToken', () => signedOut)
    .onErrorTag(
      'GitLabCatalogError',
      error =>
        `GitLab wouldn't turn the flow on: ${error.message}. CodeTinder needs GitLab Duo's Agent Platform on the project (Premium or Ultimate).`,
    )
    .onErrorTag(
      'SetupFilesExist',
      error => `Some setup files are already in the project, so no MR was opened: ${error.message}`,
    )
    .onFailure(() => "GitLab didn't answer this time. Nothing's lost: try again.")
    .orNull();

  return (
    <Modal
      {...modal}
      title={
        isFinishing
          ? `Finish adding CodeTinder to ${project.name}?`
          : `Add CodeTinder to ${project.name}?`
      }
      isBusy={isAdding}
    >
      {/* Step two: what will change, then the buttons. */}
      <div className={dialogBodyClass}>
        <ul className="my-4 grid gap-5">
          {needsFlow && (
            <Change title="Turns on the codetinder flow">
              <p className={dialogChangeTextClass}>
                GitLab adds its bot to the project. It starts a round when a merge request opens or
                is marked ready, or when you add it as a reviewer; you can change that on the
                project's page.
              </p>
            </Change>
          )}
          {needsSetupMergeRequest && (
            <Change title="Opens a merge request, “Add CodeTinder 💘”">
              <p className={dialogChangeTextClass}>
                Nothing swipes until you merge it. Its install and test commands are guesses, so
                give them a look. It adds:
              </p>
              <SetupFiles projectId={project.id} />
            </Change>
          )}
        </ul>
        {project.addability._tag === 'Blocked' && (
          <p className={dialogErrorClass} role="alert">
            {blockReasonCopy[project.addability.reason]}
          </p>
        )}
        {failure && (
          <p className={dialogErrorClass} role="alert">
            {failure}
          </p>
        )}
      </div>
      <div className={dialogFootClass}>
        {given === undefined && (
          <button
            type="button"
            className={cn(dialogGhostClass, 'mr-auto')}
            disabled={isAdding}
            onClick={() => {
              add(Atom.Reset);
              setPickedId(null);
            }}
          >
            Back
          </button>
        )}
        <button
          type="button"
          className={dialogConfirmClass}
          disabled={isAdding || project.addability._tag === 'Blocked'}
          onClick={() => {
            if (project.addability._tag === 'Blocked') return;
            add({
              projectId: project.id,
              defaultBranch: project.addability.defaultBranch,
              needsFlow,
              needsSetupMergeRequest,
              setupMergeRequestUrl,
            });
          }}
        >
          {isAdding ? 'Adding…' : confirmLabel}
          <HeartIcon weight="fill" aria-hidden="true" />
        </button>
      </div>
    </Modal>
  );
};
