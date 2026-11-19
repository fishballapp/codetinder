import { Checkbox } from '@base-ui/react/checkbox';
import { Field } from '@base-ui/react/field';
import { ROUND_STARTS, type RoundStart } from '@codetinder/gitlab';
import { cn } from '@codetinder/ui';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { CheckIcon } from '@phosphor-icons/react';
import * as Option from 'effect/Option';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { type ReactNode, useState } from 'react';
import { type ProjectWithState, roundTriggerAtom, setRoundStartAtom } from '../state/atoms';
import { leadClass } from './ProjectsLayout';

const noteClass = 'text-[0.95rem] leading-[1.45] text-pretty text-ink-soft';
const pathClass = 'font-mono text-[0.9em]';

/** Each way a round can start: what the box says, and what it means for the team. */
const ROUND_START_COPY: Record<RoundStart, { readonly label: string; readonly hint: ReactNode }> = {
  opened: {
    label: 'When an MR is opened or marked ready',
    hint: 'A draft waits until it’s marked ready.',
  },
  reviewer: {
    label: 'When CodeTinder is added as a reviewer',
    hint: 'Draft or not. Re-request review to start a new round on the latest commit.',
  },
  push: {
    label: 'On every push',
    hint: 'Drafts too. Each push starts a short CodeTinder run, billed to your GitLab credits and runner minutes, even on a branch with no MR, where it stops at once.',
  },
};

/**
 * One way as a checkbox row: its label beside the box, what it means described below. A fixed
 * row is always on: its box can't be changed, but its label reads as plainly as the rest.
 */
const RoundStartBox = ({
  label,
  hint,
  isChecked,
  isDisabled,
  isFixed = false,
  onCheckedChange,
  children,
}: {
  readonly label: ReactNode;
  readonly hint: ReactNode;
  readonly isChecked: boolean;
  readonly isDisabled: boolean;
  readonly isFixed?: boolean;
  readonly onCheckedChange?: (isChecked: boolean) => void;
  readonly children?: ReactNode;
}) => (
  <Field.Root
    disabled={isDisabled || isFixed}
    className="grid gap-1 px-6 py-4 not-first:border-t not-first:border-rule max-sm:px-5"
  >
    <Field.Label
      className={cn(
        'flex min-h-11 cursor-pointer items-center gap-4 text-[1.1rem] font-semibold text-ink data-[disabled]:cursor-default data-[disabled]:text-ink-faint',
        isFixed && 'data-[disabled]:text-ink',
      )}
    >
      <Checkbox.Root
        checked={isChecked}
        onCheckedChange={onCheckedChange}
        className="flex size-[1.4rem] flex-none items-center justify-center rounded-[7px] border-2 border-petal bg-card text-white transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lipstick data-[checked]:border-lipstick data-[checked]:bg-lipstick data-[disabled]:opacity-50 motion-reduce:transition-none"
      >
        <Checkbox.Indicator className="flex data-[unchecked]:hidden">
          <CheckIcon weight="bold" className="size-[0.95rem]" aria-hidden="true" />
        </Checkbox.Indicator>
      </Checkbox.Root>
      {label}
    </Field.Label>
    <Field.Description className={cn(noteClass, 'pl-[2.4rem]')}>{hint}</Field.Description>
    {children}
  </Field.Root>
);

/** The note under the boxes, when something holds them back. */
const roundStartsNoteFor = ({
  canManageFlow,
  shownCount,
  isCurrent,
}: {
  readonly canManageFlow: boolean;
  readonly shownCount: number;
  /** False for a trigger from before a way gained an event: any tick rewrites it current. */
  readonly isCurrent: boolean;
}): string | null => {
  if (!canManageFlow) return 'Only someone allowed to manage this project’s flows can change this.';
  if (shownCount === 0) return 'Pick at least one, or no round will start.';
  if (!isCurrent) {
    return 'Set up by an older CodeTinder: tick or untick a box to bring it up to date.';
  }
  if (shownCount === 1) return 'One stays ticked, or no round would start.';
  return null;
};

/** The mention that starts a round, by the flow's account when GitLab named it. */
const MentionLabel = ({ username }: { readonly username: Option.Option<string> }) =>
  Option.match(username, {
    onNone: () => (
      <span>
        When someone mentions CodeTinder with <code className={pathClass}>round</code>
      </span>
    ),
    onSome: accountName => (
      <span>
        When someone mentions <code className={pathClass}>@{accountName} round</code>
      </span>
    ),
  });

/** The boxes, each saved to the trigger as it is ticked or unticked. */
const RoundStartsForm = ({
  project,
  consumerId,
  saved,
  isCurrent,
  hasCiConfig,
  serviceAccountUsername,
}: {
  readonly project: ProjectWithState;
  readonly consumerId: string;
  readonly saved: ReadonlySet<RoundStart>;
  readonly isCurrent: boolean;
  readonly hasCiConfig: boolean;
  readonly serviceAccountUsername: Option.Option<string>;
}) => {
  const [result, setRoundStart] = useAtom(setRoundStartAtom);
  // The ways the saves in flight write, shown until the last of them ends.
  const [pending, setPending] = useState(saved);
  const shown = result.waiting ? pending : saved;
  // Without CI a push starts nothing, so push is shown off.
  const shownStarts = hasCiConfig ? shown : shown.difference(new Set(['push']));
  const note = roundStartsNoteFor({
    canManageFlow: project.canManageFlow,
    shownCount: shownStarts.size,
    isCurrent,
  });
  const setStart = (start: RoundStart, isOn: boolean) => {
    setPending(isOn ? shown.union(new Set([start])) : shown.difference(new Set([start])));
    setRoundStart({
      projectId: project.id,
      projectFullPath: project.fullPath,
      consumerId,
      defaultBranch: project.defaultBranch,
      start,
      isOn,
    });
  };

  return (
    <>
      <div>
        {ROUND_STARTS.map(start => {
          const needsCi = start === 'push' && !hasCiConfig;
          const isLastTicked = shownStarts.size === 1 && shownStarts.has(start);
          return (
            <RoundStartBox
              key={start}
              label={ROUND_START_COPY[start].label}
              hint={ROUND_START_COPY[start].hint}
              isChecked={shownStarts.has(start)}
              isDisabled={!project.canManageFlow || needsCi || isLastTicked}
              onCheckedChange={isChecked => setStart(start, isChecked)}
            >
              {needsCi && (
                <Field.Description className={cn(noteClass, 'pl-[2.4rem] font-semibold text-wine')}>
                  Needs CI: this project has no <code className={pathClass}>.gitlab-ci.yml</code>,
                  so a push starts no pipeline for CodeTinder to hear.
                </Field.Description>
              )}
            </RoundStartBox>
          );
        })}
        <RoundStartBox
          label={<MentionLabel username={serviceAccountUsername} />}
          hint="Always on: starts a fresh round on the latest commit, even one that has a round. Done mentions CodeTinder too, to learn your swipes."
          isChecked
          isDisabled
          isFixed
        />
      </div>
      {note !== null && (
        <footer className="border-t border-rule bg-card-sunk px-6 py-4 max-sm:px-5">
          <p className={noteClass}>{note}</p>
        </footer>
      )}
    </>
  );
};

const Notice = ({ children }: { readonly children: ReactNode }) => (
  <p className={cn(noteClass, 'px-6 py-5 max-sm:px-5')}>{children}</p>
);

const RoundStartsCard = ({
  project,
  consumerId,
}: {
  readonly project: ProjectWithState;
  readonly consumerId: string;
}) =>
  AsyncResult.builder(useAtomValue(roundTriggerAtom(project.id)))
    .onInitial(() => <Notice>Reading how rounds start…</Notice>)
    .onSuccess(({ trigger, hasCiConfig, serviceAccountUsername }) => {
      if (trigger._tag === 'None') {
        return (
          <Notice>
            No round starts here: this project’s CodeTinder trigger was deleted in GitLab. Remove
            CodeTinder and add it again to get a new one.
          </Notice>
        );
      }
      return (
        <RoundStartsForm
          project={project}
          consumerId={consumerId}
          saved={trigger.value.starts}
          isCurrent={trigger.value.isCurrent}
          hasCiConfig={hasCiConfig}
          serviceAccountUsername={serviceAccountUsername}
        />
      );
    })
    .onFailure(() => <Notice>Couldn’t read how rounds start. Reload to try again.</Notice>)
    .render();

/** How the project's rounds start, read off its flow's trigger and saved back to it. */
export const RoundStartsSection = ({ project }: { readonly project: ProjectWithState }) => {
  const { consumerId } = project;
  if (consumerId === null) return null;
  return (
    <section className="mt-[clamp(2.5rem,7vw,4rem)]" aria-labelledby="round-starts-title">
      <h2
        id="round-starts-title"
        className="font-display text-[clamp(1.75rem,1.3rem_+_1.2vw,2.5rem)] leading-[1.1] font-bold text-balance text-candy-red text-shadow-emboss"
      >
        When to start a round
      </h2>
      <p className={leadClass}>
        CodeTinder starts a round on a merge request at the moments you tick. Each commit gets one
        round, however many you tick.
      </p>
      <article className="overflow-hidden rounded-[16px] bg-card shadow-card">
        <RoundStartsCard project={project} consumerId={consumerId} />
      </article>
    </section>
  );
};
